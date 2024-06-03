import { EvmPriceServiceConnection } from '@perennial/pyth-evm-js'
import { Address, Hex, PublicClient, encodeFunctionData, getAddress } from 'viem'

import { MultiInvokerAbi, PythFactoryAbi } from '../..'
import { OrderTypes, PositionSide, SupportedChainId, TriggerComparison, addressToAsset } from '../../constants'
import { InterfaceFeeBps, ReferrerInterfaceFeeInfo } from '../../constants'
import { MultiInvokerAddresses, PythFactoryAddresses } from '../../constants/contracts'
import { MultiInvokerAction } from '../../types/perennial'
import { Big6Math, BigOrZero, notEmpty, nowSeconds } from '../../utils'
import {
  EmptyInterfaceFee,
  buildCancelOrder,
  buildCommitPrice,
  buildPlaceTriggerOrder,
  buildUpdateMarket,
} from '../../utils/multiinvoker'
import { calcInterfaceFee } from '../../utils/positionUtils'
import { buildCommitmentsForOracles, getRecentVaa } from '../../utils/pythUtils'
import { getMultiInvokerContract, getOracleContract } from '../contracts'
import { MarketOracles, MarketSnapshots, fetchMarketOracles, fetchMarketSnapshots } from './chain'
import { OrderExecutionDeposit } from './constants'
import { OpenOrder } from './graph'

type WithChainIdAndPublicClient = {
  chainId: SupportedChainId
  publicClient: PublicClient
}

export type BuildModifyPositionTxArgs = {
  marketAddress: Address
  marketSnapshots?: MarketSnapshots
  marketOracles?: MarketOracles
  pythClient: EvmPriceServiceConnection
  address: Address
  collateralDelta?: bigint
  positionAbs?: bigint
  positionSide?: PositionSide
  stopLoss?: bigint
  takeProfit?: bigint
  settlementFee?: bigint
  cancelOrderDetails?: OpenOrder[]
  absDifferenceNotional?: bigint
  interfaceFee?: { interfaceFee: bigint; referrerFee: bigint; ecosystemFee: bigint }
  interfaceFeeRate?: InterfaceFeeBps
  referralFeeRate?: ReferrerInterfaceFeeInfo
  onCommitmentError?: () => any
} & WithChainIdAndPublicClient

export async function buildModifyPositionTx({
  chainId,
  publicClient,
  marketAddress,
  marketSnapshots,
  marketOracles,
  pythClient,
  address,
  positionSide,
  positionAbs,
  collateralDelta,
  stopLoss,
  takeProfit,
  settlementFee,
  cancelOrderDetails,
  absDifferenceNotional,
  interfaceFee,
  interfaceFeeRate,
  referralFeeRate,
  onCommitmentError,
}: BuildModifyPositionTxArgs) {
  const multiInvoker = getMultiInvokerContract(chainId, publicClient)

  if (!marketOracles) {
    marketOracles = await fetchMarketOracles(chainId, publicClient)
  }

  if (!marketSnapshots) {
    marketSnapshots = await fetchMarketSnapshots({
      publicClient,
      chainId,
      address,
      marketOracles,
      pythClient,
    })
  }

  let cancelOrders: MultiInvokerAction[] = []

  if (cancelOrderDetails?.length) {
    cancelOrders = buildCancelOrderActions(cancelOrderDetails)
  }

  const oracleInfo = Object.values(marketOracles).find((o) => o.marketAddress === marketAddress)
  if (!oracleInfo) return

  const asset = addressToAsset(marketAddress)

  // Interface fee
  const interfaceFees: Array<typeof EmptyInterfaceFee> = []
  const feeRate = positionSide && interfaceFeeRate ? interfaceFeeRate.feeAmount[positionSide] : 0n
  const tradeFeeBips =
    absDifferenceNotional && interfaceFee?.interfaceFee
      ? Big6Math.div(interfaceFee.interfaceFee, absDifferenceNotional)
      : 0n
  if (
    interfaceFee?.interfaceFee &&
    interfaceFeeRate &&
    tradeFeeBips <= Big6Math.mul(feeRate, Big6Math.fromFloatString('1.05'))
  ) {
    const referrerFee = interfaceFee.referrerFee
    const ecosystemFee = interfaceFee.ecosystemFee

    // If there is a referrer fee, send it to the referrer as USDC
    if (referralFeeRate && referrerFee > 0n)
      interfaceFees.push({
        unwrap: true,
        receiver: getAddress(referralFeeRate.referralTarget),
        amount: referrerFee,
      })

    if (ecosystemFee > 0n) {
      interfaceFees.push({
        unwrap: false, // default recipient holds DSU
        receiver: interfaceFeeRate.feeRecipientAddress,
        amount: ecosystemFee,
      })
    }
  } else if (tradeFeeBips > Big6Math.mul(feeRate, Big6Math.fromFloatString('1.05'))) {
    console.error('Fee exceeds rate - waiving.', address)
  }

  const updateAction = buildUpdateMarket({
    market: marketAddress,
    maker: positionSide === PositionSide.maker ? positionAbs : undefined, // Absolute position size
    long: positionSide === PositionSide.long ? positionAbs : undefined,
    short: positionSide === PositionSide.short ? positionAbs : undefined,
    collateral: collateralDelta ?? 0n, // Delta collateral
    wrap: true,
    interfaceFee: interfaceFees.at(0),
    interfaceFee2: interfaceFees.at(1),
  })

  const isNotMaker = positionSide !== PositionSide.maker && positionSide !== PositionSide.none
  let stopLossAction
  if (stopLoss && positionSide && isNotMaker && settlementFee) {
    stopLossAction = buildTriggerOrder({
      chainId,
      price: stopLoss,
      side: positionSide,
      referralFeeRate,
      interfaceFeeRate,
      positionDelta: -(positionAbs ?? 0n),
      marketAddress,
      maxFee: settlementFee * 2n,
      triggerComparison: positionSide === PositionSide.short ? TriggerComparison.gte : TriggerComparison.lte,
    })
  }

  let takeProfitAction
  if (takeProfit && positionSide && isNotMaker && settlementFee) {
    takeProfitAction = buildTriggerOrder({
      chainId,
      price: takeProfit,
      side: positionSide,
      referralFeeRate,
      interfaceFeeRate,
      positionDelta: -(positionAbs ?? 0n),
      marketAddress,
      maxFee: settlementFee * 2n,
      triggerComparison: positionSide === PositionSide.short ? TriggerComparison.lte : TriggerComparison.gte,
    })
  }

  const actions: MultiInvokerAction[] = [updateAction, stopLossAction, takeProfitAction, ...cancelOrders].filter(
    notEmpty,
  )

  // Default to price being stale if we don't have any market snapshots
  let isPriceStale = true
  const marketSnapshot = asset && marketSnapshots?.market[asset]
  if (marketSnapshot && marketSnapshots) {
    const {
      parameter: { maxPendingGlobal, maxPendingLocal },
      riskParameter: { staleAfter },
      pendingPositions,
    } = marketSnapshot
    const lastUpdated = await getOracleContract(oracleInfo.address, publicClient).read.latest()
    isPriceStale = BigInt(nowSeconds()) - lastUpdated.timestamp > staleAfter / 2n
    // If there is a backlog of pending positions, we need to commit the price
    isPriceStale = isPriceStale || BigInt(pendingPositions.length) >= maxPendingGlobal
    // If there is a backlog of pending positions for this user, we need to commit the price
    isPriceStale = isPriceStale || BigOrZero(marketSnapshots.user?.[asset]?.pendingPositions?.length) >= maxPendingLocal
  }

  // Only add the price commit if the price is stale
  if (isPriceStale) {
    const [{ version, ids, value, updateData }] = await buildCommitmentsForOracles({
      chainId,
      pyth: pythClient,
      publicClient,
      marketOracles: [oracleInfo],
      onError: onCommitmentError,
    })
    const commitAction = buildCommitPrice({
      keeperFactory: oracleInfo.providerFactoryAddress,
      version,
      value,
      ids,
      vaa: updateData,
      revertOnFailure: false,
    })

    actions.unshift(commitAction)
  }
  const data = encodeFunctionData({
    functionName: 'invoke',
    abi: multiInvoker.abi,
    args: [address, actions],
  })
  return {
    data,
    to: multiInvoker.address,
    value: 1n,
  }
}

export type BuildSubmitVaaTxArgs = {
  chainId: SupportedChainId
  pythClient: EvmPriceServiceConnection
  marketAddress: Address
  marketOracles: MarketOracles
}

export async function buildSubmitVaaTx({ chainId, marketAddress, marketOracles, pythClient }: BuildSubmitVaaTxArgs) {
  const oracleInfo = Object.values(marketOracles).find((o) => o.marketAddress === marketAddress)
  if (!oracleInfo) return

  const [{ version, vaa }] = await getRecentVaa({
    pyth: pythClient,
    feeds: [oracleInfo],
  })

  const data = encodeFunctionData({
    functionName: 'commit',
    abi: PythFactoryAbi,
    args: [[oracleInfo.providerId], version, vaa as Hex],
  })
  return {
    data,
    to: PythFactoryAddresses[chainId],
    value: 1n,
  }
}

export type CancelOrderDetails = { market: Address; nonce: bigint } | OpenOrder

type BuildTriggerOrderBaseArgs = {
  address: Address
  marketAddress: Address
  orderType: OrderTypes
  side: PositionSide
  delta: bigint
  positionAbs: bigint
  selectedLimitComparison?: TriggerComparison
  referralFeeRate?: ReferrerInterfaceFeeInfo
  interfaceFeeRate?: InterfaceFeeBps
  cancelOrderDetails?: CancelOrderDetails[]
  pythClient: EvmPriceServiceConnection
  marketOracles?: MarketOracles
  marketSnapshots?: MarketSnapshots
  onCommitmentError?: () => any
} & WithChainIdAndPublicClient

export type BuildLimitOrderTxArgs = {
  limitPrice: bigint
  collateralDelta?: bigint
} & BuildTriggerOrderBaseArgs

export async function buildLimitOrderTx({
  address,
  chainId,
  pythClient,
  marketOracles,
  publicClient,
  marketAddress,
  limitPrice,
  marketSnapshots,
  collateralDelta,
  side,
  delta = 0n,
  selectedLimitComparison,
  referralFeeRate,
  interfaceFeeRate,
  onCommitmentError,
}: BuildLimitOrderTxArgs) {
  if (!address || !chainId || !pythClient) {
    return
  }

  if (!marketOracles) {
    marketOracles = await fetchMarketOracles(chainId, publicClient)
  }

  if (!marketSnapshots) {
    marketSnapshots = await fetchMarketSnapshots({
      publicClient,
      chainId,
      address,
      marketOracles,
      pythClient,
    })
  }

  const multiInvoker = getMultiInvokerContract(chainId, publicClient)
  const asset = addressToAsset(marketAddress)
  const marketSnapshot = asset && marketSnapshots?.market[asset]

  let updateAction

  if (collateralDelta) {
    updateAction = buildUpdateMarket({
      market: marketAddress,
      maker: undefined,
      long: undefined,
      short: undefined,
      collateral: collateralDelta,
      wrap: true,
    })
  }
  const comparison = selectedLimitComparison
    ? selectedLimitComparison
    : side === PositionSide.long
      ? TriggerComparison.lte
      : TriggerComparison.gte

  const limitOrderAction = buildTriggerOrder({
    chainId,
    latestPrice:
      // Set interface fee price as latest price if order will execute immediately (as a market order)
      comparison === 'lte'
        ? Big6Math.min(limitPrice, marketSnapshot?.global.latestPrice ?? 0n)
        : Big6Math.max(limitPrice, marketSnapshot?.global.latestPrice ?? 0n),
    price: limitPrice,
    side: side as PositionSide.long | PositionSide.short,
    referralFeeRate,
    interfaceFeeRate,
    positionDelta: delta,
    marketAddress,
    maxFee: OrderExecutionDeposit,
    triggerComparison: comparison,
  })

  const actions: MultiInvokerAction[] = [updateAction, limitOrderAction].filter(notEmpty)

  if (collateralDelta) {
    const oracleInfo = Object.values(marketOracles).find((o) => o.marketAddress === marketAddress)
    if (!oracleInfo) return
    const asset = addressToAsset(marketAddress)
    let isPriceStale = false
    if (marketSnapshot && marketSnapshots && asset) {
      const {
        parameter: { maxPendingGlobal, maxPendingLocal },
        riskParameter: { staleAfter },
        pendingPositions,
      } = marketSnapshot
      const lastUpdated = await getOracleContract(oracleInfo.address, publicClient).read.latest()
      isPriceStale = BigInt(nowSeconds()) - lastUpdated.timestamp > staleAfter / 2n
      // If there is a backlog of pending positions, we need to commit the price
      isPriceStale = isPriceStale || BigInt(pendingPositions.length) >= maxPendingGlobal
      // If there is a backlog of pending positions for this user, we need to commit the price
      isPriceStale =
        isPriceStale || BigOrZero(marketSnapshots.user?.[asset]?.pendingPositions?.length) >= maxPendingLocal
    }

    // Only add the price commit if the price is stale
    if (isPriceStale) {
      const [{ version, ids, value, updateData }] = await buildCommitmentsForOracles({
        chainId,
        pyth: pythClient,
        publicClient,
        marketOracles: [oracleInfo],
        onError: onCommitmentError,
      })

      const commitAction = buildCommitPrice({
        keeperFactory: oracleInfo.providerAddress,
        version,
        value,
        ids,
        vaa: updateData,
        revertOnFailure: false,
      })

      actions.unshift(commitAction)
    }
  }
  const data = encodeFunctionData({
    functionName: 'invoke',
    abi: multiInvoker.abi,
    args: [address, actions],
  })
  return {
    data,
    to: multiInvoker.address,
    value: 1n,
  }
}

export type BuildStopLossTxArgs = {
  stopLoss: bigint
} & BuildPlaceOrderTxArgs

export async function buildStopLossTx({
  address,
  chainId,
  marketAddress,
  stopLoss,
  side,
  delta = 0n,
  referralFeeRate,
  interfaceFeeRate,
  publicClient,
}: BuildStopLossTxArgs) {
  const multiInvoker = getMultiInvokerContract(chainId, publicClient)

  const stopLossAction = buildTriggerOrder({
    chainId,
    price: stopLoss,
    side: side as PositionSide.long | PositionSide.short,
    referralFeeRate,
    interfaceFeeRate,
    positionDelta: delta,
    marketAddress,
    maxFee: OrderExecutionDeposit,
    triggerComparison: side === PositionSide.short ? TriggerComparison.gte : TriggerComparison.lte,
  })
  const actions: MultiInvokerAction[] = [stopLossAction]

  const data = encodeFunctionData({
    functionName: 'invoke',
    abi: multiInvoker.abi,
    args: [address, actions],
  })

  return {
    data,
    to: multiInvoker.address,
    value: 1n,
  }
}

export type BuildTakeProfitTxArgs = {
  takeProfit: bigint
} & BuildPlaceOrderTxArgs

export async function buildTakeProfitTx({
  address,
  chainId,
  marketAddress,
  takeProfit,
  side,
  delta = 0n,
  referralFeeRate,
  interfaceFeeRate,
  publicClient,
}: BuildTakeProfitTxArgs) {
  const multiInvoker = getMultiInvokerContract(chainId, publicClient)

  const takeProfitAction = buildTriggerOrder({
    chainId,
    price: takeProfit,
    side: side as PositionSide.long | PositionSide.short,
    referralFeeRate,
    interfaceFeeRate,
    positionDelta: delta,
    marketAddress,
    maxFee: OrderExecutionDeposit,
    triggerComparison: side === PositionSide.short ? TriggerComparison.lte : TriggerComparison.gte,
  })
  const actions: MultiInvokerAction[] = [takeProfitAction]

  const data = encodeFunctionData({
    functionName: 'invoke',
    abi: multiInvoker.abi,
    args: [address, actions],
  })

  return {
    data,
    to: multiInvoker.address,
    value: 1n,
  }
}

export type BuildPlaceOrderTxArgs = {
  orderType: OrderTypes
  limitPrice?: bigint
  stopLoss?: bigint
  takeProfit?: bigint
  collateralDelta?: bigint
} & BuildTriggerOrderBaseArgs

function buildCancelOrderActions(orders: CancelOrderDetails[]) {
  return orders.map(({ market, nonce }) => {
    const marketAddress = getAddress(market)
    const formattedNonce = BigInt(nonce)
    return buildCancelOrder({ market: marketAddress, nonce: formattedNonce })
  })
}

export type BuildCancelOrderTxArgs = {
  chainId: SupportedChainId
  address: Address
  orderDetails: CancelOrderDetails[]
}
export function buildCancelOrderTx({ chainId, address, orderDetails }: BuildCancelOrderTxArgs) {
  const actions: MultiInvokerAction[] = buildCancelOrderActions(orderDetails)

  const data = encodeFunctionData({
    functionName: 'invoke',
    abi: MultiInvokerAbi,
    args: [address, actions],
  })
  return {
    data,
    to: MultiInvokerAddresses[chainId],
    value: 0n,
  }
}

export type BuildTriggerOrderArgs = {
  chainId: SupportedChainId
  price: bigint
  latestPrice?: bigint
  side: PositionSide.long | PositionSide.short
  referralFeeRate?: ReferrerInterfaceFeeInfo
  interfaceFeeRate?: InterfaceFeeBps
  positionDelta: bigint
  marketAddress: Address
  maxFee: bigint
  triggerComparison: TriggerComparison
}

export function buildTriggerOrder({
  chainId,
  latestPrice,
  price,
  side,
  referralFeeRate,
  interfaceFeeRate,
  positionDelta,
  marketAddress,
  maxFee,
  triggerComparison,
}: BuildTriggerOrderArgs) {
  const interfaceFee = calcInterfaceFee({
    chainId,
    latestPrice: latestPrice ?? price,
    side,
    referrerInterfaceFeeDiscount: referralFeeRate?.discount ?? 0n,
    referrerInterfaceFeeShare: referralFeeRate?.share ?? 0n,
    positionDelta,
    interfaceFeeBps: interfaceFeeRate,
  })

  return buildPlaceTriggerOrder({
    market: marketAddress,
    side,
    triggerPrice: price,
    comparison: triggerComparison,
    maxFee,
    delta: positionDelta,
    interfaceFee:
      referralFeeRate && interfaceFee.referrerFee
        ? {
            unwrap: true,
            receiver: getAddress(referralFeeRate.referralTarget),
            amount: interfaceFee.referrerFee,
          }
        : undefined,
    interfaceFee2:
      interfaceFee.ecosystemFee > 0n && interfaceFeeRate
        ? {
            unwrap: false,
            receiver: interfaceFeeRate.feeRecipientAddress,
            amount: interfaceFee.ecosystemFee,
          }
        : undefined,
  })
}

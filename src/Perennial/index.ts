import { HermesClient } from '@pythnetwork/hermes-client'
import { GraphQLClient } from 'graphql-request'
import { Address, Chain, PublicClient, Transport, WalletClient, createPublicClient, http } from 'viem'

import { ChainMarkets, SupportedChainId, SupportedMarket } from '..'
import { DefaultChain, chainIdToChainMap } from '../constants/network'
import { ContractsModule } from '../lib/contracts'
import { MarketsModule } from '../lib/markets'
import { OperatorModule } from '../lib/operators'
import { VaultsModule } from '../lib/vaults'

export type SDKConfig = {
  rpcUrl: string
  chainId: SupportedChainId
  graphUrl?: string
  pythUrl: string
  walletClient?: WalletClient
  operatingFor?: Address
  supportedMarkets?: SupportedMarket[]
}

/**
 * Perennial SDK class
 *
 * @param config SDK configuration
 * @param config.rpcUrl Rpc URL
 * @param config.walletClient Wallet Client
 * @param config.chainId {@link SupportedChainId}
 * @param config.graphUrl SubGraph URL
 * @param config.pythUrl Pyth URL
 * @param config.operatingFor If set, the SDK will read data and send multi-invoker transactions on behalf of this address.
 * @param config.supportedMarkets Subset of availalbe markets to support.
 *
 * @returns Perennial SDK instance
 *
 * @beta
 */
export default class PerennialSDK {
  private config: SDKConfig & { supportedMarkets: SupportedMarket[] }
  private _currentChainId: SupportedChainId = DefaultChain.id
  private _publicClient: PublicClient<Transport<'http'>, Chain>
  private _walletClient?: WalletClient
  private _pythClient: HermesClient
  private _graphClient: GraphQLClient | undefined
  public contracts: ContractsModule
  public markets: MarketsModule
  public vaults: VaultsModule
  public operator: OperatorModule

  constructor(config: SDKConfig) {
    this.config = {
      ...config,
      supportedMarkets:
        config.supportedMarkets && config.supportedMarkets.length
          ? config.supportedMarkets
          : (Object.keys(ChainMarkets[config.chainId]) as SupportedMarket[]),
    }
    this._publicClient = createPublicClient({
      chain: chainIdToChainMap[config.chainId] as Chain,
      transport: http(config.rpcUrl),
      batch: {
        multicall: true,
      },
    })
    this._pythClient = new HermesClient(config.pythUrl, {
      timeout: 30000,
    })
    this._graphClient = config.graphUrl ? new GraphQLClient(config.graphUrl) : undefined
    this.contracts = new ContractsModule({
      chainId: config.chainId,
      publicClient: this._publicClient,
      signer: config.walletClient,
    })
    this.markets = new MarketsModule({
      chainId: config.chainId,
      publicClient: this._publicClient,
      walletClient: config.walletClient,
      graphClient: this._graphClient,
      pythClient: this._pythClient,
      operatingFor: this.config.operatingFor,
      supportedMarkets: this.config.supportedMarkets,
    })
    this.vaults = new VaultsModule({
      chainId: config.chainId,
      publicClient: this._publicClient,
      walletClient: config.walletClient,
      graphClient: this._graphClient,
      pythClient: this._pythClient,
      operatingFor: this.config.operatingFor,
    })
    this.operator = new OperatorModule({
      chainId: config.chainId,
      publicClient: this._publicClient,
      walletClient: config.walletClient,
      operatingFor: this.config.operatingFor,
    })

    this._walletClient = config.walletClient
    this._currentChainId = config.chainId
  }

  get currentChainId() {
    return this._currentChainId
  }

  get rpcProviderUrl() {
    return this.config.rpcUrl
  }

  get walletClient() {
    return this._walletClient
  }

  get publicClient() {
    return this._publicClient
  }

  get graphClient() {
    if (!this._graphClient) throw new Error('Graph client not initialized')
    return this._graphClient
  }

  get pythClient() {
    return this._pythClient
  }
}

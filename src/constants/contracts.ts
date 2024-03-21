import { Address, getAddress } from 'viem'
import { arbitrum, arbitrumSepolia, base } from 'viem/chains'

import { SupportedChainId } from './network'

type AddressMapping = { [chain in SupportedChainId]: Address }

export const MultiInvokerV2Addresses: AddressMapping = {
  [arbitrum.id]: getAddress('0x431603567EcBb4aa1Ce5a4fdBe5554cAEa658832'),
  [arbitrumSepolia.id]: getAddress('0x1927DE7c9765Ae74050D1d0aa8BB0e93D737F579'),
  [base.id]: getAddress('0xf3E88d5a0036BFDc240A309DBc765C895Dc8b509'),
}

export const MarketFactoryAddresses: AddressMapping = {
  [arbitrum.id]: getAddress('0xDaD8A103473dfd47F90168A0E46766ed48e26EC7'),
  [arbitrumSepolia.id]: getAddress('0x32F3aB7b3c5BBa0738b72FdB83FcE6bb1a1a943c'),
  [base.id]: getAddress('0xE04290314A35f5c29D0b0f7dA0C1499a0ecC44F7'),
}

export const VaultFactoryAddresses: AddressMapping = {
  [arbitrum.id]: getAddress('0xad3565680aEcEe27A39249D8c2D55dAc79BE5Ad0'),
  [arbitrumSepolia.id]: getAddress('0x877682C7a8840D59A63a6227ED2Aeb20C3ae7FeB'),
  [base.id]: getAddress('0x7c4ABBF7CB0C0BcB72917734B068Ed4D1AcdF8C5'),
}

export const OracleFactoryAddresses: AddressMapping = {
  [arbitrum.id]: getAddress('0x8CDa59615C993f925915D3eb4394BAdB3feEF413'),
  [arbitrumSepolia.id]: getAddress('0x9d2CaE012AAe0aE00f4d8F42CD287a6923612456'),
  [base.id]: getAddress('0xC76be4488789d5fc60636f1c5b2c6e173D3d4942'),
}

export const DSUAddresses: AddressMapping = {
  [arbitrum.id]: getAddress('0x52C64b8998eB7C80b6F526E99E29ABdcC86B841b'),
  [arbitrumSepolia.id]: getAddress('0x5FA881826AD000D010977645450292701bc2f56D'),
  [base.id]: getAddress('0x7b4Adf64B0d60fF97D672E473420203D52562A84'),
}

export const USDCAddresses: AddressMapping = {
  [arbitrum.id]: getAddress('0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8'),
  [arbitrumSepolia.id]: getAddress('0x16b38364bA6f55B6E150cC7f52D22E89643f3535'),
  [base.id]: getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
}

export const PythFactoryAddresses: AddressMapping = {
  [arbitrum.id]: getAddress('0x6b60e7c96B4d11A63891F249eA826f8a73Ef4E6E'),
  [arbitrumSepolia.id]: getAddress('0x92F8d5B8d0ca2fc699c7c540471Ad49724a68007'),
  [base.id]: getAddress('0x9c82732CE868aFA5e9b2649506E7Ab8268A62c3C'),
}

import { LCDClient } from '@terra-money/terra.js';
import { AddressProvider } from '../../address-provider/types';

interface Option {
  lcd: LCDClient;
  market: string;
}
interface StateResponse {
  totalLiabilites: string;
  totalReserves: string;
  lastInterestUpdated: number;
  globalInterestIndex: string;
}

export const queryMarketState = ({ lcd, market }: Option) => async (
  addressProvider: AddressProvider.Provider,
): Promise<StateResponse> => {
  const marketContractAddress = addressProvider.market(market);
  let response: StateResponse = await lcd.wasm.contractQuery(
    marketContractAddress,
    {
      state: {},
    },
  );
  return response;
};
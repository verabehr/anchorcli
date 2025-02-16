import * as commander from 'commander';
import * as Parse from './parse-input';
import * as yaml from 'yaml';
import { execSync } from 'child_process';
import { SignMode } from '@terra-money/terra.proto/cosmos/tx/signing/v1beta1/signing';
import {
  Coins,
  MsgExecuteContract,
  LCDClient,
  AuthInfo,
  Tx,
  TxBody,
  SignOptions,
  Fee,
} from '@terra-money/terra.js';
import { CLIKey } from '@terra-money/terra.js/dist/key/CLIKey';
import { loadConfig } from './config';
const jsome = require('jsome');
//@ts-ignore
const yesno = require('yesno');

export function getLCDClient(chainId?: string): LCDClient {
  return new LCDClient(loadConfig(chainId).lcd);
}

export function createExecMenu(
  name: string,
  description: string,
): commander.Command {
  const exec = new commander.Command(name);
  exec
    .description(description)
    .option('--yaml', 'Encode result as YAML instead of JSON')
    .option('-y,--yes', 'Sign transaction without confirming (yes)')
    .option('--home <string>', 'Directory for config of terrad')
    .option('--from <key-name>', '*Name of key in terrad keyring')
    .option(
      '--generate-only',
      'Build an unsigned transaction and write it to stdout',
    )
    .option(
      '-G,--generate-msg',
      'Build an ExecuteMsg (good for including in poll)',
    )
    .option('--base64', 'For --generate-msg: returns msg as base64')
    .option(
      '-b,--broadcast-mode <string>',
      'Transaction broadcasting mode (sync|async|block) (default: sync)',
      'sync',
    )
    // StdSignMsg
    .option('--chain-id <string>', 'Chain ID of Terra node')
    .option(
      '-a,--account-number <int>',
      'The account number of the signing account (offline mode)',
    )
    .option(
      '-s,--sequence <int>',
      'The sequence number of the signing account (offline mode)',
    )
    .option('--memo <string>', 'Memo to send along with transaction')
    // Fees & Gas
    .option('--fees <coins>', 'Fees to pay along with transaction')
    .option(
      '--gas <int|auto>',
      '*Gas limit to set per-transaction; set to "auto" to calculate required gas automatically',
    )
    .option(
      '--gas-adjustment <float>',
      'Adjustment factor to be multiplied against the estimate returned by the tx simulation',
    )
    .option(
      '--gas-prices <coins>',
      'Gas prices to determine the transaction fee (e.g. 10uluna,12.5ukrw)',
    );

  return exec;
}

export function createQueryMenu(
  name: string,
  description: string,
): commander.Command {
  const query = new commander.Command(name);
  query
    .description(description)
    .option('--yaml', 'Encode result as YAML instead of JSON')
    .option('--chain-id <string>', 'Chain ID of Terra node');
  return query;
}

export async function handleExecCommand(
  exec: commander.Command,
  msgs: MsgExecuteContract[],
) {
  if (!exec.generateMsg) {
    if (exec.from === undefined) {
      throw new Error(
        `--from <key-name> must be provided if not --generate-msg`,
      );
    }

    if (exec.gas === undefined) {
      throw new Error(
        `--gas <int|auto> must be provided if not --generate-msg`,
      );
    }
  }

  if (exec.generateMsg) {
    if (exec.base64) {
      return console.log(
        Buffer.from(JSON.stringify(msgs[0].execute_msg)).toString('base64'),
      );
    }
    return console.log(JSON.stringify(msgs[0].execute_msg));
  }

  const lcd = getLCDClient(exec.chainId);
  let key = new CLIKey({ keyName: exec.from, home: exec.home });

  const keyType = JSON.parse(
    execSync(`terrad keys show ${exec.from} --output json`).toString(),
  ).type;

  const wallet = lcd.wallet(key);

  const chainId: string = exec.chainId ? exec.chainId : lcd.config.chainID;

  const memo: string = exec.memo ? exec.memo : '';

  let accountNumber: number;
  let sequence: number;

  if (!!exec.accountNumber || !!exec.sequence) {
    // don't look up account-number and sequence values from blockchain
    // ensure that both account number and sequence number are set
    if (exec.accountNumber === undefined || exec.sequence === undefined) {
      throw new Error(
        `both account-number and sequence must be provided if one is provided.`,
      );
    }
    accountNumber = Parse.int(exec.accountNumber);
    sequence = Parse.int(exec.sequence);
  } else {
    // looks up wallet values from blockchain
    const accountInfo = await wallet.accountNumberAndSequence();
    accountNumber = accountInfo.account_number;
    sequence = accountInfo.sequence;
  }

  let gas: number;
  let feeAmount: Coins = new Coins({});

  if (exec.gas === 'auto') {
    // estimate gas
    const estimatedFee = (
      await lcd.tx.create(key.accAddress, {
        msgs,
        accountNumber: accountNumber,
        sequence,
        gasPrices: exec.gasPrices,
        gasAdjustment: exec.gasAdjustment,
        memo,
      })
    ).auth_info.fee;

    gas = Number(estimatedFee.toAmino().gas);

    if (exec.fees === undefined) {
      feeAmount = estimatedFee.amount;
    } else {
      feeAmount = Parse.coins(exec.fees);
    }
  } else {
    if (exec.fees === undefined) {
      feeAmount = new Coins({});
    } else {
      feeAmount = Parse.coins(exec.fees);
    }

    gas = Parse.int(exec.gas);
  }

  const unsignedTx = new Tx(
    new TxBody(msgs, memo),
    new AuthInfo([], new Fee(gas, feeAmount)),
    [],
  );

  const signOptions: SignOptions = {
    accountNumber,
    sequence,
    signMode:
      keyType === 'ledger'
        ? SignMode.SIGN_MODE_LEGACY_AMINO_JSON
        : SignMode.SIGN_MODE_DIRECT,
    chainID: chainId,
  };

  if (exec.generateOnly) {
    if (exec.yaml) {
      console.log(yaml.stringify(unsignedTx.toData()));
    } else {
      jsome(unsignedTx.toData());
    }
  } else {
    if (!exec.yes) {
      let msg = unsignedTx.body.messages[0].toData() as any;
      msg.execute_msg = (unsignedTx.body
        .messages[0] as MsgExecuteContract).execute_msg;

      console.log(
        yaml.stringify({
          chainId,
          msg,
          fee: unsignedTx.auth_info.fee.toData(),
          memo,
        }),
      );

      //@ts-ignore
      const ok = await yesno({
        question: `Confirm and sign transaction with key ${exec.from}? (y/N)`,
        defaultValue: false,
      });

      if (!ok) {
        console.log('Process aborted.');
        process.exit(1);
      }
    }

    const signedTx = await key.signTx(unsignedTx, signOptions);
    let result;

    switch (exec.broadcastMode) {
      case 'sync':
        result = await lcd.tx.broadcastSync(signedTx);
        break;
      case 'async':
        result = await lcd.tx.broadcastAsync(signedTx);
        break;
      case 'block':
        result = await lcd.tx.broadcast(signedTx);
        break;
      default:
        throw new Error(
          `invalid broadcast-mode '${exec.broadcastMode}' - must be sync|async|block`,
        );
    }
    if (exec.yaml) {
      console.log(yaml.stringify(result));
    } else {
      jsome(result);
    }
  }
}

export async function handleQueryCommand(query: commander.Command, T: any) {
  if (query.yaml) {
    console.log(yaml.stringify(T));
  } else {
    console.log(T);
  }
}

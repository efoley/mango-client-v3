/**
 This will probably move to its own repo at some point but easier to keep it here for now
 */
import * as os from 'os';
import * as fs from 'fs';
import { MangoClient } from './client';
import {
  Account,
  Commitment,
  Connection,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import { getMultipleAccounts, sleep } from './utils';
import configFile from './ids.json';
import { Cluster, Config } from './config';
import BN from 'bn.js';
import {
  decodeEventQueue,
  DexInstructions,
  Market,
} from '@project-serum/serum';
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';

const interval = process.env.INTERVAL || 3500;
const maxUniqueAccounts = parseInt(process.env.MAX_UNIQUE_ACCOUNTS || '10');
const consumeEventsLimit = new BN(process.env.CONSUME_EVENTS_LIMIT || '10');
const config = new Config(configFile);

const cluster = (process.env.CLUSTER || 'devnet') as Cluster;
const groupName = 'mango_test_v3.max'; // this one contains all spot markets
// const groupName = process.env.GROUP || 'mango_test_v3.7';
const groupIds = config.getGroup(cluster, groupName);

if (!groupIds) {
  throw new Error(`Group ${groupName} not found`);
}
const mangoProgramId = groupIds.mangoProgramId;
const mangoGroupKey = groupIds.publicKey;
const payer = new Account(
  JSON.parse(
    process.env.KEYPAIR ||
      fs.readFileSync(os.homedir() + '/.config/solana/devnet.json', 'utf-8'),
  ),
);

const connection = new Connection(
  config.cluster_urls[cluster],
  'processed' as Commitment,
);
const client = new MangoClient(connection, mangoProgramId);

async function run() {
  if (!groupIds) {
    throw new Error(`Group ${groupName} not found`);
  }
  const mangoGroup = await client.getMangoGroup(mangoGroupKey);

  const spotMarkets = await Promise.all(
    groupIds.spotMarkets.map((m) => {
      return Market.load(
        connection,
        m.publicKey,
        {
          skipPreflight: true,
          commitment: 'processed' as Commitment,
        },
        mangoGroup.dexProgramId,
      );
    }),
  );

  const quoteToken = new Token(
    connection,
    spotMarkets[0].quoteMintAddress,
    TOKEN_PROGRAM_ID,
    payer,
  );
  const quoteWallet = await quoteToken
    .getOrCreateAssociatedAccountInfo(payer.publicKey)
    .then((a) => a.address);

  const baseWallets = await Promise.all(
    spotMarkets.map((m) => {
      const token = new Token(
        connection,
        m.baseMintAddress,
        TOKEN_PROGRAM_ID,
        payer,
      );

      return token
        .getOrCreateAssociatedAccountInfo(payer.publicKey)
        .then((a) => a.address);
    }),
  );

  const eventQueuePks = spotMarkets.map(
    (market) => market['_decoded'].eventQueue,
  );

  // eslint-disable-next-line
  while (true) {
    await sleep(interval);
    const eventQueueAccts = await getMultipleAccounts(
      connection,
      eventQueuePks,
    );
    eventQueueAccts.forEach(({ accountInfo }, i) => {
      const events = decodeEventQueue(accountInfo.data);

      if (events.length === 0) {
        return;
      }

      const accounts: Set<string> = new Set();
      for (const event of events) {
        accounts.add(event.openOrders.toBase58());

        // Limit unique accounts to first 10
        if (accounts.size >= maxUniqueAccounts) {
          break;
        }
      }

      const instr = DexInstructions.consumeEvents({
        market: spotMarkets[i].publicKey,
        eventQueue: spotMarkets[i]['_decoded'].eventQueue,
        coinFee: baseWallets[i],
        pcFee: quoteWallet,
        openOrdersAccounts: Array.from(accounts)
          .map((s) => new PublicKey(s))
          .sort(),
        limit: consumeEventsLimit,
        programId: mangoGroup.dexProgramId,
      });

      const transaction = new Transaction();
      transaction.add(instr);

      console.log(
        'market',
        i,
        'sending consume events for',
        events.length,
        'events',
      );
      client.sendTransaction(transaction, payer, []);
    });
  }
}

run();
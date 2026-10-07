import { NextRequest } from "next/server";
import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  SendTransactionError,
} from "@solana/web3.js";
import {
  errorResponse,
  isBase64,
  isDecimalInteger,
  json,
  readJson,
  rejectIfUnsafe,
} from "../_security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const U64_MAX = (1n << 64n) - 1n;
const c = () => new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
async function retry<T>(fn: () => Promise<T>) { let last: unknown; for (let i = 0; i < 3; i++) { try { return await fn(); } catch (e) { last = e; await new Promise((resolve) => setTimeout(resolve, 250 * (i + 1))); } } throw last; }

function address(value: unknown, field: string) {
  if (typeof value !== "string" || value.length > 64) throw Error(`Invalid ${field}`);
  try {
    return new PublicKey(value);
  } catch {
    throw Error(`Invalid ${field}`);
  }
}

function addresses(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw Error("Provide between 1 and 100 public keys");
  }
  return value.map((item) => address(item, "public key"));
}

export async function POST(request: NextRequest) {
  const blocked = rejectIfUnsafe(request, "rpc", 90);
  if (blocked) return blocked;
  try {
    const body = await readJson<any>(request);
    const action = body.action;

    if (action === "balances") {
      const pubs = addresses(body.publicKeys);
      const connection = c();
      const infos = await retry(() => connection.getMultipleAccountsInfo(pubs));
      return json({
        balances: pubs.map((pub, index) => {
          const lamports = infos[index]?.lamports || 0;
          return { publicKey: pub.toBase58(), raw: String(lamports), ui: String(lamports / LAMPORTS_PER_SOL) };
        }),
      });
    }

    if (action === "mint") {
      const mint = address(body.mint, "mint");
      const info = await retry(() => c().getParsedAccountInfo(mint));
      if (!info.value || !("parsed" in info.value.data)) throw Error("Mint unavailable");
      return json({ decimals: info.value.data.parsed.info.decimals });
    }

    if (action === "tokens") {
      const mint = address(body.mint, "mint");
      const pubs = addresses(body.publicKeys);
      const out = await Promise.all(pubs.map(async (owner) => {
        try {
          const accounts = await retry(() => c().getParsedTokenAccountsByOwner(owner, { mint }));
          const raw = accounts.value.reduce((sum, account) => sum + BigInt(account.account.data.parsed.info.tokenAmount.amount || "0"), 0n);
          return { publicKey: owner.toBase58(), raw: String(raw) };
        } catch {
          return { publicKey: owner.toBase58(), raw: "0" };
        }
      }));
      const info = await retry(() => c().getParsedAccountInfo(mint));
      const decimals = info.value && "parsed" in info.value.data ? info.value.data.parsed.info.decimals : 0;
      return json({ balances: out, decimals });
    }

    if (action === "holdings") {
      const pubs = addresses(body.publicKeys);
      const tokenProgram = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
      const out = await Promise.all(pubs.map(async (owner) => {
        try {
          const accounts = await c().getParsedTokenAccountsByOwner(owner, { programId: tokenProgram });
          const tokens = accounts.value.map((account) => {
            const info = account.account.data.parsed.info;
            return { mint: info.mint, amount: info.tokenAmount.amount, decimals: info.tokenAmount.decimals, uiAmount: info.tokenAmount.uiAmountString || "0" };
          }).filter((token) => token.amount !== "0");
          const sol = await c().getBalance(owner);
          return { publicKey: owner.toBase58(), sol: String(sol / LAMPORTS_PER_SOL), tokens };
        } catch {
          return { publicKey: owner.toBase58(), sol: "0", tokens: [] };
        }
      }));
      return json({ holdings: out });
    }

    if (action === "blockhash") {
      return json(await retry(() => c().getLatestBlockhash("confirmed")));
    }

    if (action === "send") {
      if (!isBase64(body.signedTransaction)) throw Error("Invalid signed transaction");
      const connection = c();
      try {
        const signature = await retry(() => connection.sendRawTransaction(Buffer.from(body.signedTransaction, "base64"), { skipPreflight: false, maxRetries: 3 }));
        return json({ signature });
      } catch (error) {
        if (error instanceof SendTransactionError) {
          const logs = error.logs || await error.getLogs(connection).catch(() => null);
          const detail = logs?.length ? ` Logs: ${JSON.stringify(logs)}` : "";
          throw Error(`${error.transactionError?.message || "Transaction simulation failed"}${detail}`);
        }
        throw error;
      }
    }

    if (action === "simulate") {
      if (!isBase64(body.signedTransaction)) throw Error("Invalid signed transaction");
      const transaction = Transaction.from(Buffer.from(body.signedTransaction, "base64"));
      const simulation = await retry(() => c().simulateTransaction(transaction));
      return json({ err: simulation.value.err, logs: simulation.value.logs || [] });
    }

    if (action === "estimateTransferFee") {
      const from = address(body.from, "source wallet");
      const to = address(body.to, "destination wallet");
      if (!isDecimalInteger(body.lamports)) throw Error("Invalid transfer amount");
      const lamports = BigInt(body.lamports);
      if (lamports < 0n || lamports > U64_MAX) throw Error("Transfer amount is out of range");
      const connection = c();
      const latest = await retry(() => connection.getLatestBlockhash("confirmed"));
      const transaction = new Transaction({ recentBlockhash: latest.blockhash, feePayer: from }).add(
        SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports }),
      );
      const [fee, rentLamports] = await Promise.all([
        retry(() => connection.getFeeForMessage(transaction.compileMessage(), "confirmed")),
        retry(() => connection.getMinimumBalanceForRentExemption(0)),
      ]);
      return json({ blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, feeLamports: fee.value ?? 5000, rentLamports });
    }

    if (action === "masterTransferPlan") {
      const source = address(body.source, "master wallet");
      if (!Array.isArray(body.recipients) || body.recipients.length < 1 || body.recipients.length > 100) throw Error("Provide between 1 and 100 recipients");
      const recipients: PublicKey[] = body.recipients.map((item: unknown) => address(item, "recipient wallet"));
      const unique = new Set(recipients.map((recipient) => recipient.toBase58()));
      if (unique.size !== recipients.length) throw Error("Recipient wallets must be unique");
      if (recipients.some((recipient) => recipient.equals(source))) throw Error("Master wallet cannot fund itself");
      if (!isDecimalInteger(body.lamportsPerWallet)) throw Error("Invalid amount per wallet");
      const lamports = BigInt(body.lamportsPerWallet);
      if (lamports <= 0n || lamports > U64_MAX) throw Error("Amount per wallet is out of range");
      const plans: string[] = [];
      for (let i = 0; i < recipients.length; i += 8) {
        const batch = recipients.slice(i, i + 8);
        const blockhash = await c().getLatestBlockhash("confirmed");
        const transaction = new Transaction({ recentBlockhash: blockhash.blockhash, feePayer: source });
        batch.forEach((recipient) => transaction.add(SystemProgram.transfer({ fromPubkey: source, toPubkey: recipient, lamports })));
        plans.push(Buffer.from(transaction.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64"));
      }
      return json({ transactions: plans, count: recipients.length });
    }

    throw Error("Unknown action");
  } catch (error) {
    return errorResponse(error);
  }
}

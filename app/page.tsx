"use client";
import { useEffect, useMemo, useState } from "react";
import {
  Keypair,
  VersionedTransaction,
  Transaction,
  SystemProgram,
  PublicKey,
} from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
const SOL = "So11111111111111111111111111111111111111112",
  KEY = "sol-bundler-v1",
  POS = "sol-bundler-positions-v1",
  MASTER_KEY = "sol-bundler-master-v1",
  PHANTOM_PENDING_KEY = "sol-bundler-phantom-pending-v1",
  PHANTOM_SESSION_KEY = "sol-bundler-phantom-session-v1",
  PHANTOM_TX_KEY = "sol-bundler-phantom-tx-v1",
  TRADE_COUNTS_KEY = "sol-bundler-trade-counts-v1";
type W = {
  id: string;
  label: string;
  pub: string;
  sec: string;
  sol?: string;
  raw?: string;
};
type V = { v: 1; w: W[] };
type R = { label: string; status: string; sig?: string; error?: string };
type H = {
  publicKey: string;
  sol: string;
  tokens: { mint: string; amount?: string; uiAmount: string; decimals: number }[];
};
type P = { id: string; mint: string; walletIds: string[]; created: number };
type TabId = "overview" | "wallets" | "funding" | "trade";
type PhantomSession = {
  dappPublicKey: string;
  dappSecretKey: string;
  sharedSecret: string;
  session: string;
  publicKey: string;
};
type SolProvider = { publicKey?: { toBase58: () => string }; connect: () => Promise<{ publicKey: { toBase58: () => string } }>; signAndSendTransaction: (tx: any) => Promise<{ signature: string }> };
declare global {
  interface Window {
    solana?: SolProvider;
    phantom?: { solana?: SolProvider };
    solflare?: SolProvider;
    backpack?: SolProvider;
  }
}
const enc = new TextEncoder(),
  dec = new TextDecoder(),
  b64 = (u: Uint8Array) => {
    let s = "";
    u.forEach((x) => (s += String.fromCharCode(x)));
    return btoa(s);
  },
  unb = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function key(p: string, s: Uint8Array<ArrayBuffer>) {
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(p),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: s, iterations: 310000, hash: "SHA-256" },
    k,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
async function seal(v: V, p: string) {
  const s = crypto.getRandomValues(new Uint8Array(16)),
    iv = crypto.getRandomValues(new Uint8Array(12)),
    k = await key(p, s),
    ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      k,
      enc.encode(JSON.stringify(v)),
    );
  return JSON.stringify({ s: b64(s), iv: b64(iv), d: b64(new Uint8Array(ct)) });
}
async function open(x: string, p: string) {
  const z = JSON.parse(x),
    s = unb(z.s),
    iv = unb(z.iv),
    k = await key(p, s),
    pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, k, unb(z.d));
  return JSON.parse(dec.decode(pt)) as V;
}
const short = (s: string) => s.slice(0, 5) + "…" + s.slice(-5),
  raw = (x: string, d: number) => {
    if (!/^\d+(\.\d+)?$/.test(x)) throw Error("Invalid amount");
    const [a, b = ""] = x.split(".");
    if (b.length > d) throw Error("Too many decimals");
    return BigInt((a + b.padEnd(d, "0")).replace(/^0+(?=\d)/, "") || "0");
  };
function decryptPhantom(data: string, nonce: string, sharedSecret: Uint8Array) {
  const opened = nacl.box.open.after(
    bs58.decode(data),
    bs58.decode(nonce),
    sharedSecret,
  );
  if (!opened) throw Error("Unable to decrypt Phantom response");
  return JSON.parse(new TextDecoder().decode(opened)) as Record<string, string>;
}
async function post<T>(url: string, body: any) {
  const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    j = await r.json();
  if (!r.ok) throw Error(j.error || "Request failed");
  return j as T;
}
async function map5<T, R>(a: T[], fn: (x: T) => Promise<R>) {
  const out: R[] = [];
  let i = 0;
  async function w() {
    while (i < a.length) {
      const n = i++;
      out[n] = await fn(a[n]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, a.length) }, w));
  return out;
}
const DEVICE_SESSION_DB = "solana-wallet-bundler-device-v1",
  DEVICE_SESSION_STORE = "session",
  DEVICE_SESSION_KEY = "device-key",
  DEVICE_SESSION_SECRET = "device-password";
type DeviceSessionSecret = { iv: string; d: string };
function openDeviceSessionDb() {
  if (typeof indexedDB === "undefined") throw Error("Device session storage is unavailable.");
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DEVICE_SESSION_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DEVICE_SESSION_STORE)) {
        request.result.createObjectStore(DEVICE_SESSION_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || Error("Unable to open device session storage."));
  });
}
function getDeviceSessionValue<T>(db: IDBDatabase, key: IDBValidKey) {
  return new Promise<T | null>((resolve, reject) => {
    const request = db.transaction(DEVICE_SESSION_STORE, "readonly").objectStore(DEVICE_SESSION_STORE).get(key);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
    request.onerror = () => reject(request.error || Error("Unable to read device session storage."));
  });
}
function putDeviceSessionValue(db: IDBDatabase, key: IDBValidKey, value: unknown) {
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(DEVICE_SESSION_STORE, "readwrite");
    transaction.objectStore(DEVICE_SESSION_STORE).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || Error("Unable to save device session storage."));
  });
}
function deleteDeviceSessionValue(db: IDBDatabase, key: IDBValidKey) {
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(DEVICE_SESSION_STORE, "readwrite");
    transaction.objectStore(DEVICE_SESSION_STORE).delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || Error("Unable to clear device session storage."));
  });
}
async function rememberDevicePassword(password: string) {
  let db: IDBDatabase | undefined;
  try {
    db = await openDeviceSessionDb();
    let deviceKey = await getDeviceSessionValue<CryptoKey>(db, DEVICE_SESSION_KEY);
    if (!deviceKey) {
      deviceKey = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
      await putDeviceSessionValue(db, DEVICE_SESSION_KEY, deviceKey);
    }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      deviceKey,
      enc.encode(password),
    );
    await putDeviceSessionValue(db, DEVICE_SESSION_SECRET, {
      iv: b64(iv),
      d: b64(new Uint8Array(encrypted)),
    } satisfies DeviceSessionSecret);
  } catch {
    // The vault remains usable; the password will be requested after a reload
    // if this browser does not support durable device storage.
  } finally {
    db?.close();
  }
}
async function forgetDevicePassword() {
  let db: IDBDatabase | undefined;
  try {
    db = await openDeviceSessionDb();
    await deleteDeviceSessionValue(db, DEVICE_SESSION_SECRET);
  } catch {
    // Nothing else should prevent the vault from opening manually.
  } finally {
    db?.close();
  }
}
async function restoreDevicePassword() {
  let db: IDBDatabase | undefined;
  try {
    db = await openDeviceSessionDb();
    const deviceKey = await getDeviceSessionValue<CryptoKey>(db, DEVICE_SESSION_KEY);
    const secret = await getDeviceSessionValue<DeviceSessionSecret>(db, DEVICE_SESSION_SECRET);
    if (!deviceKey || !secret) return null;
    const password = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb(secret.iv) },
      deviceKey,
      unb(secret.d),
    );
    return dec.decode(password);
  } catch {
    await forgetDevicePassword();
    return null;
  } finally {
    db?.close();
  }
}
export default function Page() {
  const [exists, setExists] = useState(false),
    [vault, setVault] = useState<V | null>(null),
    [pass, setPass] = useState(""),
    [p1, setP1] = useState(""),
    [p2, setP2] = useState(""),
    [sel, setSel] = useState<Set<string>>(new Set()),
    [msg, setMsg] = useState(""),
    [busy, setBusy] = useState(false),
    [mint, setMint] = useState(""),
    [act, setAct] = useState<"BUY" | "SELL">("BUY"),
    [mode, setMode] = useState<"FIXED" | "PERCENT">("FIXED"),
    [amt, setAmt] = useState("0.01"),
    [pct, setPct] = useState(25),
    [res, setRes] = useState<R[]>([]),
    [bundleCount, setBundleCount] = useState(25),
    [fundingCount, setFundingCount] = useState(0),
    [tradeCount, setTradeCount] = useState(0),
    [tradeCounts, setTradeCounts] = useState<Record<string, number>>({}),
    [detail, setDetail] = useState<W | null>(null),
    [holdings, setHoldings] = useState<H | null>(null),
    [dest, setDest] = useState(""),
    [withdrawAmt, setWithdrawAmt] = useState(""),
    [positions, setPositions] = useState<P[]>([]),
    [master, setMaster] = useState(""),
    [fundAmt, setFundAmt] = useState("0.02"),
    [funding, setFunding] = useState(false),
    [masterStatus, setMasterStatus] = useState(""),
    [addCount, setAddCount] = useState("25"),
    [balanceHistory, setBalanceHistory] = useState<{ t: number; value: number }[]>([]),
    [activeTab, setActiveTab] = useState<TabId>("overview"),
    [sessionChecked, setSessionChecked] = useState(false);
  useEffect(() => {
    const encryptedVault = localStorage.getItem(KEY);
    setExists(!!encryptedVault);
    if (!encryptedVault) {
      setSessionChecked(true);
    } else {
      void (async () => {
        const remembered = await restoreDevicePassword();
        if (remembered) {
          try {
            const v = await open(encryptedVault, remembered);
            setPass(remembered);
            setVault(v);
            setBundleCount(0);
            await balances(v);
          } catch {
            await forgetDevicePassword();
          }
        }
        setSessionChecked(true);
      })();
    }
    try {
      setPositions(JSON.parse(localStorage.getItem(POS) || "[]"));
    } catch {}
    try {
      setTradeCounts(JSON.parse(localStorage.getItem(TRADE_COUNTS_KEY) || "{}"));
    } catch {}
    setMaster(localStorage.getItem(MASTER_KEY) || "");
    const params = new URLSearchParams(window.location.search);
    const errorCode = params.get("errorCode");
    const errorMessage = params.get("errorMessage");
    const data = params.get("data");
    const nonce = params.get("nonce");
    const phantomKey = params.get("phantom_encryption_public_key");
    const phantomAction = params.get("phantom");
    if (errorCode || errorMessage) {
      setMasterStatus(`Phantom request was not approved${errorMessage ? `: ${errorMessage}` : "."}`);
      localStorage.removeItem(PHANTOM_PENDING_KEY);
      localStorage.removeItem(PHANTOM_TX_KEY);
      window.history.replaceState({}, "", window.location.pathname);
    } else if (data && nonce && phantomKey) {
      try {
        const pending = JSON.parse(localStorage.getItem(PHANTOM_PENDING_KEY) || "null") as { secret: string; public: string } | null;
        if (!pending) throw Error("The Phantom connection request expired. Try again.");
        const shared = nacl.box.before(bs58.decode(phantomKey), bs58.decode(pending.secret));
        const result = decryptPhantom(data, nonce, shared);
        const connected = new PublicKey(result.public_key).toBase58();
        const saved = localStorage.getItem(MASTER_KEY);
        if (saved && new PublicKey(saved).toBase58() !== connected) {
          throw Error(`Connected wallet ${short(connected)} does not match the saved master address.`);
        }
        const session: PhantomSession = {
          dappPublicKey: pending.public,
          dappSecretKey: pending.secret,
          sharedSecret: bs58.encode(shared),
          session: result.session,
          publicKey: connected,
        };
        localStorage.setItem(PHANTOM_SESSION_KEY, JSON.stringify(session));
        localStorage.removeItem(PHANTOM_PENDING_KEY);
        localStorage.setItem(MASTER_KEY, connected);
        setMaster(connected);
        setMasterStatus(`Phantom connected and verified: ${short(connected)}`);
      } catch (e) {
        setMasterStatus(e instanceof Error ? e.message : String(e));
      }
      window.history.replaceState({}, "", window.location.pathname);
    } else if (data && nonce && phantomAction === "sign") {
      const pending = JSON.parse(localStorage.getItem(PHANTOM_TX_KEY) || "null") as { transactions: string[]; index: number } | null;
      const session = JSON.parse(localStorage.getItem(PHANTOM_SESSION_KEY) || "null") as PhantomSession | null;
      if (!pending || !session) {
        setMasterStatus("The Phantom signing request expired. Start funding again.");
        window.history.replaceState({}, "", window.location.pathname);
        return;
      }
      void (async () => {
        try {
          const result = decryptPhantom(data, nonce, bs58.decode(session.sharedSecret));
          if (!result.transaction) throw Error("Phantom returned no signed transaction.");
          await post<{ signature: string }>("/api/rpc", {
            action: "send",
            signedTransaction: b64(bs58.decode(result.transaction)),
          });
          const nextIndex = pending.index + 1;
          if (nextIndex < pending.transactions.length) {
            localStorage.setItem(PHANTOM_TX_KEY, JSON.stringify({ ...pending, index: nextIndex }));
            setMasterStatus(`Approved ${nextIndex} of ${pending.transactions.length}. Opening Phantom for the next transfer…`);
            beginPhantomSign(pending.transactions[nextIndex], session);
          } else {
            localStorage.removeItem(PHANTOM_TX_KEY);
            setMasterStatus(`Funding approved for ${pending.transactions.length} wallet${pending.transactions.length === 1 ? "" : "s"}.`);
          }
        } catch (e) {
          localStorage.removeItem(PHANTOM_TX_KEY);
          setMasterStatus(e instanceof Error ? e.message : String(e));
        }
        window.history.replaceState({}, "", window.location.pathname);
      })();
    }
  }, []);
  const wallets = vault?.w || [],
    walletKey = wallets.map((w) => w.pub).join(","),
    chosen = useMemo(
      () => wallets.slice(0, Math.min(Math.max(bundleCount, 0), wallets.length)),
      [wallets, bundleCount],
    ),
    total = wallets.reduce((s, w) => s + Number(w.sol || 0), 0),
    fundingChosen = useMemo(() => wallets.slice(0, Math.min(Math.max(fundingCount, 0), wallets.length)), [wallets, fundingCount]),
    fundTotal = fundingChosen.length * (Number(fundAmt) || 0);
  useEffect(() => {
    if (!vault || !walletKey) return;
    let stopped = false;
    const tick = () => {
      if (!stopped) void balances(vault);
    };
    void tick();
    const id = window.setInterval(tick, 5000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void balances(vault);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [walletKey]);
  const chartPoints = balanceHistory.length ? balanceHistory : [{ t: Date.now(), value: total }], chartMin = Math.min(...chartPoints.map((p) => p.value)), chartMax = Math.max(...chartPoints.map((p) => p.value)), chartRange = Math.max(chartMax - chartMin, 0.0001), chartLine = chartPoints.map((p, i) => `${(i / Math.max(chartPoints.length - 1, 1)) * 100},${100 - ((p.value - chartMin) / chartRange) * 86 - 7}`).join(" ");
  const tradeChosen = useMemo(() => wallets.slice(0, Math.min(Math.max(tradeCount, 0), wallets.length)), [wallets, tradeCount]);
  function setTradeRange(n: number) {
    const count = Number.isFinite(n) && n > 0 ? Math.min(wallets.length, Math.floor(n)) : 0;
    setTradeCount(count);
    if (mint) {
      const next = { ...tradeCounts, [mint]: count };
      setTradeCounts(next);
      localStorage.setItem(TRADE_COUNTS_KEY, JSON.stringify(next));
    }
  }
  function changeMint(value: string) {
    setMint(value);
    setTradeCount(value ? Number(tradeCounts[value] || 0) : 0);
  }
  function beginPhantomSign(encoded: string, session: PhantomSession) {
    const nonce = nacl.randomBytes(24);
    const encrypted = nacl.box.after(
      enc.encode(JSON.stringify({ transaction: bs58.encode(unb(encoded)), session: session.session })),
      nonce,
      bs58.decode(session.sharedSecret),
    );
    const redirect = `${window.location.origin}${window.location.pathname}?phantom=sign`;
    const query = new URLSearchParams({
      dapp_encryption_public_key: session.dappPublicKey,
      nonce: bs58.encode(nonce),
      redirect_link: redirect,
      payload: bs58.encode(encrypted),
    });
    window.location.assign(`https://phantom.app/ul/v1/signTransaction?${query.toString()}`);
  }
  async function save(v: V, p = pass) {
    localStorage.setItem(KEY, await seal(v, p));
    setVault(v);
  }
  async function setup() {
    try {
      setBusy(true);
      if (p1.length < 12) throw Error("Use at least 12 characters");
      if (p1 !== p2) throw Error("Passwords do not match");
      const w = Array.from({ length: 25 }, (_, i) => {
        const k = Keypair.generate();
        return {
          id: crypto.randomUUID(),
          label: `Wallet ${String(i + 1).padStart(2, "0")}`,
          pub: k.publicKey.toBase58(),
          sec: bs58.encode(k.secretKey),
        };
      });
      const v = { v: 1 as const, w };
      await save(v, p1);
      await rememberDevicePassword(p1);
      setPass(p1);
      setExists(true);
      setBundleCount(0);
      setMsg(
        "25 encrypted wallets created. Download a backup before funding them.",
      );
      await balances(v);
    } catch (e) {
      setMsg(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }
  async function unlock() {
    try {
      setBusy(true);
      const x = localStorage.getItem(KEY);
      if (!x) throw Error("No vault found");
      const v = await open(x, p1);
      await rememberDevicePassword(p1);
      setPass(p1);
      setVault(v);
      setBundleCount(0);
      await balances(v);
    } catch (e) {
      setMsg("Unlock failed: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }
  async function balances(v = vault!) {
    if (!v) return;
    try {
      const j = await post<{
          balances: { publicKey: string; ui: string; raw: string }[];
        }>("/api/rpc", {
          action: "balances",
          publicKeys: v.w.map((x) => x.pub),
        }),
        m = new Map(j.balances.map((x) => [x.publicKey, x]));
      const nextVault = {
        ...v,
        w: v.w.map((x) => ({
          ...x,
          sol: m.get(x.pub)?.ui || "0",
          raw: m.get(x.pub)?.raw || "0",
        })),
      };
      setVault(nextVault);
      setBalanceHistory((h) => [...h.slice(-59), { t: Date.now(), value: nextVault.w.reduce((s, w) => s + Number(w.sol || 0), 0) }]);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }
  async function inspect(w: W) {
    setActiveTab("wallets");
    setDetail(w);
    setHoldings(null);
    try {
      const j = await post<{ holdings: H[] }>("/api/rpc", {
        action: "holdings",
        publicKeys: [w.pub],
      });
      setHoldings(j.holdings[0]);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }
  async function recoverPositions() {
    if (!wallets.length) return;
    try {
      setBusy(true);
      const j = await post<{ holdings: H[] }>("/api/rpc", { action: "holdings", publicKeys: wallets.map((w) => w.pub) });
      const byMint = new Map<string, string[]>();
      j.holdings.forEach((h) => h.tokens.filter((t) => BigInt(t.amount || "0") > 0n).forEach((t) => {
        const ids = byMint.get(t.mint) || [];
        const wallet = wallets.find((w) => w.pub === h.publicKey);
        if (wallet && !ids.includes(wallet.id)) ids.push(wallet.id);
        byMint.set(t.mint, ids);
      }));
      const next = [...positions];
      let recovered = 0;
      byMint.forEach((walletIds, tokenMint) => {
        const index = next.findIndex((p) => p.mint === tokenMint);
        if (index >= 0) {
          const merged = [...new Set([...next[index].walletIds, ...walletIds])];
          if (merged.length !== next[index].walletIds.length) next[index] = { ...next[index], walletIds: merged };
        } else {
          next.unshift({ id: crypto.randomUUID(), mint: tokenMint, walletIds, created: Date.now() });
          recovered++;
        }
      });
      setPositions(next);
      localStorage.setItem(POS, JSON.stringify(next));
      setMsg(recovered ? `Recovered ${recovered} open token position${recovered === 1 ? "" : "s"} from wallet holdings.` : "Open positions are synchronized with current wallet holdings.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (activeTab === "trade" && vault && walletKey && !busy) void recoverPositions();
  }, [activeTab, walletKey]);
  useEffect(() => {
    if (activeTab === "funding" && wallets.length && fundingCount === 0) setFundingCount(wallets.length);
  }, [activeTab, wallets.length]);
  function backup() {
    const x = localStorage.getItem(KEY);
    if (!x) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([x], { type: "application/json" }));
    a.download = "solana-wallet-vault.enc.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }
  async function importBackup(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const x = await f.text();
      JSON.parse(x);
      localStorage.setItem(KEY, x);
      setExists(true);
      setMsg(
        "Encrypted vault imported. Enter its vault password to unlock the existing wallets.",
      );
    } catch {
      setMsg("That backup file is not a valid encrypted wallet vault.");
    }
    e.target.value = "";
  }
  async function add() {
    if (!vault) return;
    const count = Number(addCount);
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      setMsg("Choose between 1 and 100 wallets to add.");
      return;
    }
    const start = vault.w.length,
      wasAllSelected = start > 0 && bundleCount === start,
      w = Array.from({ length: count }, (_, i) => {
        const k = Keypair.generate();
        return {
          id: crypto.randomUUID(),
          label: `Wallet ${String(start + i + 1).padStart(2, "0")}`,
          pub: k.publicKey.toBase58(),
          sec: bs58.encode(k.secretKey),
        };
      });
    await save({ ...vault, w: [...vault.w, ...w] });
    setBundleCount(wasAllSelected ? start + w.length : Math.min(bundleCount, start + w.length));
    setMsg(
      `Added Wallet ${String(start + 1).padStart(2, "0")} through Wallet ${String(start + w.length).padStart(2, "0")}. ${start + w.length} wallets are now available.`,
    );
  }
  async function removeWallet() {
    if (!detail || !vault) return;
    if (
      !window.confirm(
        `Delete ${detail.label}? This removes it from this encrypted vault and cannot be undone without a backup.`,
      )
    )
      return;
    const next = { ...vault, w: vault.w.filter((w) => w.id !== detail.id) };
    await save(next);
    setBundleCount(Math.max(0, Math.min(bundleCount, next.w.length)));
    setDetail(null);
    setHoldings(null);
    setMsg(
      `${detail.label} deleted. Export a backup before making more changes.`,
    );
  }
  function setRange(n: number) {
    if (!Number.isFinite(n) || n <= 0) {
      setBundleCount(0);
      setSel(new Set());
      return;
    }
    const count = Math.min(wallets.length, Math.floor(n));
    setBundleCount(count);
    setSel(new Set(wallets.slice(0, count).map((w) => w.id)));
  }
  async function withdraw() {
    if (!detail || !withdrawAmt || !dest) return;
    try {
      setBusy(true);
      const to = new PublicKey(dest),
        from = Keypair.fromSecretKey(bs58.decode(detail.sec)),
        bh = await post<{ blockhash: string }>("/api/rpc", {
          action: "blockhash",
        });
      const tx = new Transaction({
        recentBlockhash: bh.blockhash,
        feePayer: from.publicKey,
      }).add(
        SystemProgram.transfer({
          fromPubkey: from.publicKey,
          toPubkey: to,
          lamports: raw(withdrawAmt, 9),
        }),
      );
      tx.sign(from);
      const sent = await post<{ signature: string }>("/api/rpc", {
        action: "send",
        signedTransaction: b64(tx.serialize()),
      });
      setMsg(`Withdrawal submitted: ${sent.signature.slice(0, 12)}…`);
      setWithdrawAmt("");
      await balances();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function connectMaster() {
    try {
      const provider = window.solana || window.phantom?.solana || window.solflare || window.backpack;
      const entered = master.trim();
      if (!entered) throw Error("Paste a Solana master wallet address first.");
      const normalized = new PublicKey(entered).toBase58();
      setMaster(normalized);
      localStorage.setItem(MASTER_KEY, normalized);
      if (!provider) {
        const dapp = nacl.box.keyPair();
        localStorage.setItem(PHANTOM_PENDING_KEY, JSON.stringify({ secret: bs58.encode(dapp.secretKey), public: bs58.encode(dapp.publicKey) }));
        const redirect = `${window.location.origin}${window.location.pathname}`;
        const query = new URLSearchParams({
          app_url: window.location.origin,
          dapp_encryption_public_key: bs58.encode(dapp.publicKey),
          redirect_link: redirect,
          cluster: "mainnet-beta",
        });
        setMasterStatus("Opening Phantom for approval…");
        window.location.assign(`https://phantom.app/ul/v1/connect?${query.toString()}`);
        return;
      }
      const r = await provider.connect();
      const connected = r.publicKey.toBase58();
      if (connected !== normalized) throw Error(`Connected wallet ${short(connected)} does not match the address you entered.`);
      setMasterStatus(`Wallet connected and verified: ${short(connected)}`);
      localStorage.removeItem(PHANTOM_SESSION_KEY);
      setMsg("");
    } catch (e) {
      setMasterStatus(e instanceof Error ? e.message : String(e));
    }
  }
  async function consolidateWallets() {
    if (!master) {
      setMasterStatus("Connect the master wallet first.");
      return;
    }
    if (!fundingChosen.length) {
      setMasterStatus("Choose how many wallets to withdraw in the Funding tab.");
      return;
    }
    try {
      setFunding(true);
      const destination = new PublicKey(master);
      const fresh = await post<{ balances: { publicKey: string; raw: string }[] }>("/api/rpc", { action: "balances", publicKeys: fundingChosen.map((w) => w.pub) });
      const freshRaw = new Map(fresh.balances.map((b) => [b.publicKey, b.raw]));
      const rr = await map5(fundingChosen, async (w) => {
        try {
          const balance = BigInt(freshRaw.get(w.pub) || w.raw || "0");
          const from = Keypair.fromSecretKey(bs58.decode(w.sec));
          const estimate = await post<{ blockhash: string; feeLamports: number; rentLamports: number }>("/api/rpc", { action: "estimateTransferFee", from: from.publicKey.toBase58(), to: destination.toBase58(), lamports: "1" });
          const fee = BigInt(estimate.feeLamports);
          const rent = BigInt(estimate.rentLamports);
          const amount = balance - fee - rent;
          if (amount <= 0n) return { label: w.label, status: "skipped", error: "No withdrawable SOL (balance is below the network fee plus the rent reserve)" } as R;
          const tx = new Transaction({ recentBlockhash: estimate.blockhash, feePayer: from.publicKey }).add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: destination, lamports: amount }));
          tx.sign(from);
          const encoded = b64(tx.serialize());
          const simulation = await post<{ err: unknown; logs: string[] }>("/api/rpc", { action: "simulate", signedTransaction: encoded });
          if (simulation.err) {
            const logs = simulation.logs?.length ? ` Logs: ${JSON.stringify(simulation.logs)}` : "";
            throw Error(`Simulation rejected: ${JSON.stringify(simulation.err)}.${logs}`);
          }
          const sent = await post<{ signature: string }>("/api/rpc", { action: "send", signedTransaction: encoded });
          return { label: w.label, status: "success", sig: sent.signature } as R;
        } catch (e) { return { label: w.label, status: "failed", error: e instanceof Error ? e.message : String(e) } as R; }
      });
      setRes(rr);
      const sent = rr.filter((x) => x.status === "success").length;
      const skipped = rr.filter((x) => x.status === "skipped").length;
      const failed = rr.filter((x) => x.status === "failed").length;
      setMsg(`Withdrawal completed for ${sent} of ${rr.length} wallets${skipped ? `; ${skipped} had no withdrawable SOL` : ""}${failed ? `; ${failed} failed—see wallet results below.` : "."}`);
      await balances();
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    finally { setFunding(false); }
  }
  async function fundWallets() {
    const provider = window.solana || window.phantom?.solana || window.solflare || window.backpack;
    if (!master) {
      setMasterStatus("Connect the master wallet first.");
      return;
    }
    if (!fundingChosen.length) {
      setMasterStatus("Choose how many wallets to fund above.");
      return;
    }
    if (!Number.isFinite(Number(fundAmt)) || Number(fundAmt) <= 0) {
      setMasterStatus("Enter a SOL amount greater than zero for each wallet.");
      return;
    }
    try {
      setFunding(true);
      const plan = await post<{ transactions: string[] }>("/api/rpc", {
        action: "masterTransferPlan",
        source: master,
        recipients: fundingChosen.map((w) => w.pub),
        lamportsPerWallet: String(raw(fundAmt, 9)),
      });
      if (!provider) {
        const session = JSON.parse(localStorage.getItem(PHANTOM_SESSION_KEY) || "null") as PhantomSession | null;
        if (!session) throw Error("Connect the master wallet first. Phantom approval is required on mobile Safari.");
        if (!plan.transactions.length) throw Error("No funding transactions were created.");
        localStorage.setItem(PHANTOM_TX_KEY, JSON.stringify({ transactions: plan.transactions, index: 0 }));
        setMasterStatus(`Opening Phantom to approve Wallet 01 of ${fundingChosen.length}…`);
        beginPhantomSign(plan.transactions[0], session);
        return;
      }
      const signatures: string[] = [];
      for (const encoded of plan.transactions) {
        const sent = await provider.signAndSendTransaction(
          Transaction.from(unb(encoded)),
        );
        signatures.push(sent.signature);
      }
      setMsg(
        `Funding submitted for Wallet 01–${String(fundingChosen.length).padStart(2, "0")}: ${signatures.length} approval${signatures.length === 1 ? "" : "s"}.`,
      );
      await balances();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setFunding(false);
    }
  }
  async function trade(override?: { mint: string; walletIds: string[]; positionId?: string }) {
    const tradeMint = override?.mint || mint;
    const action = override ? "SELL" : act;
    const tradeMode = override ? "PERCENT" : mode;
    const tradePct = override ? 100 : pct;
    const targetWallets = override ? wallets.filter((w) => override.walletIds.includes(w.id)) : tradeChosen;
    if (!tradeMint || !targetWallets.length) return;
    setBusy(true);
    setRes([]);
    try {
      let decs = 9,
        tokens = new Map<string, string>();
      if (action === "SELL") {
        const j = await post<{
          balances: { publicKey: string; raw: string }[];
          decimals: number;
        }>("/api/rpc", {
          action: "tokens",
          mint: tradeMint,
          publicKeys: targetWallets.map((x) => x.pub),
        });
        decs = j.decimals;
        tokens = new Map(j.balances.map((x) => [x.publicKey, x.raw]));
      }
      const rr = await map5(targetWallets, async (w) => {
        try {
          let amount: bigint;
          if (action === "BUY") {
            const bal = BigInt(w.raw || "0"),
              reserve = 100_000n;
            amount =
              tradeMode === "PERCENT"
                ? bal > reserve
                  ? ((bal - reserve) * BigInt(tradePct)) / 100n
                  : 0n
                : raw(amt, 9);
            const spendable = bal > reserve ? bal - reserve : 0n;
            if (amount > spendable) amount = spendable;
          } else {
            const bal = BigInt(tokens.get(w.pub) || "0");
            amount =
              tradeMode === "PERCENT" ? (bal * BigInt(tradePct)) / 100n : raw(amt, decs);
          }
          if (amount <= 0n) throw Error("Amount is zero");
          const input = action === "BUY" ? SOL : tradeMint,
            output = action === "BUY" ? tradeMint : SOL,
            o: any = await post("/api/jupiter", {
              action: "order",
              inputMint: input,
              outputMint: output,
              amount: String(amount),
              taker: w.pub,
            });
          if (!o.transaction)
            throw Error(o.errorMessage || "No transaction returned");
          const tx = VersionedTransaction.deserialize(unb(o.transaction));
          tx.sign([Keypair.fromSecretKey(bs58.decode(w.sec))]);
          const ex: any = await post("/api/jupiter", {
            action: "execute",
            signedTransaction: b64(tx.serialize()),
            requestId: o.requestId,
            lastValidBlockHeight: o.lastValidBlockHeight,
            mevProtected: true,
          });
          if (ex.status !== "Success")
            throw Error(ex.error || `Jupiter code ${ex.code}`);
          return { label: w.label, status: "success", sig: ex.signature } as R;
        } catch (e) {
          return {
            label: w.label,
            status: "failed",
            error: e instanceof Error ? e.message : String(e),
          } as R;
        }
      });
      setRes(rr);
      const successfulIds = targetWallets.filter((_, i) => rr[i]?.status === "success").map((w) => w.id);
      if (action === "SELL" && override?.positionId && successfulIds.length) {
        const remainingIds = override.walletIds.filter((id) => !successfulIds.includes(id));
        const next = remainingIds.length
          ? positions.map((p) => p.id === override.positionId ? { ...p, walletIds: remainingIds } : p)
          : positions.filter((p) => p.id !== override.positionId);
        setPositions(next);
        localStorage.setItem(POS, JSON.stringify(next));
      }
      if (action === "BUY" && rr.some((x) => x.status === "success")) {
        const p = {
          id: crypto.randomUUID(),
          mint: tradeMint,
          walletIds: successfulIds,
          created: Date.now(),
        };
        const next = [p, ...positions];
        setPositions(next);
        localStorage.setItem(POS, JSON.stringify(next));
      }
      await balances();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  function preparePosition(p: P) {
    setActiveTab("trade");
    setMint(p.mint);
    setAct("SELL");
    setTradeCount(Math.min(wallets.length, p.walletIds.length));
    const nextCounts = { ...tradeCounts, [p.mint]: Math.min(wallets.length, p.walletIds.length) };
    setTradeCounts(nextCounts);
    localStorage.setItem(TRADE_COUNTS_KEY, JSON.stringify(nextCounts));
    window.scrollTo({
      top: document.body.scrollHeight / 2,
      behavior: "smooth",
    });
    setMsg(
      `Position loaded: first ${p.walletIds.length} wallets are selected for the simultaneous sell.`,
    );
  }
  function quickSell(p: P) {
    setActiveTab("trade");
    setMint(p.mint);
    setAct("SELL");
    setMode("PERCENT");
    setPct(100);
    setTradeCount(Math.min(wallets.length, p.walletIds.length));
    void trade({ mint: p.mint, walletIds: p.walletIds, positionId: p.id });
  }
  if (!exists)
    return (
      <main className="setup">
        <div className="ey">FIRST RUN</div>
        <h1>Solana Wallet Bundler</h1>
        <p>
          Create 25 Solana wallets directly in Safari. Their private keys are
          encrypted in this browser.
        </p>
        <label className="field">
          <span>Vault password</span>
          <input
            type="password"
            value={p1}
            onChange={(e) => setP1(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Confirm password</span>
          <input
            type="password"
            value={p2}
            onChange={(e) => setP2(e.target.value)}
          />
        </label>
        <button className="btn" onClick={setup} disabled={busy}>
          Create 25 wallets
        </button>
        <label className="importVault">
          <span>Already created wallets?</span>
          <input
            type="file"
            accept="application/json,.json"
            onChange={importBackup}
          />
        </label>
        {msg && <div className="notice">{msg}</div>}
      </main>
    );
  if (!vault)
    return !sessionChecked ? (
      <main className="setup">
        <div className="ey">DEVICE SESSION</div>
        <h1>Restoring your vault</h1>
        <p>Your encrypted wallet session is being restored on this device.</p>
      </main>
    ) : (
      <main className="setup">
        <div className="ey">ENCRYPTED VAULT</div>
        <h1>Unlock Bundler</h1>
        <label className="field">
          <span>Vault password</span>
          <input
            type="password"
            value={p1}
            onChange={(e) => setP1(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && unlock()}
          />
        </label>
        <button className="btn" onClick={unlock} disabled={busy}>
          Unlock
        </button>
        <p className="session-note">This device will remember the unlock. A new device or cleared site data will require the vault password again.</p>
        <label className="importVault">
          <span>Move an existing vault to this deployment</span>
          <input
            type="file"
            accept="application/json,.json"
            onChange={importBackup}
          />
        </label>
        {msg && <div className="notice">{msg}</div>}
      </main>
    );
  return (
    <main className="wrap">
      <div className="top">
        <div>
          <h1>Wallet Bundler</h1>
          <p>
            Coordinate your wallets from Safari. Private keys stay encrypted in
            your browser.
          </p>
        </div>
      </div>
      {msg && <div className="notice">{msg}</div>}
      <nav className="section-tabs" role="tablist" aria-label="Bundler sections">
        {(["overview", "wallets", "funding", "trade"] as const).map((tab) => (
          <button
            key={tab}
            role="tab"
            aria-selected={activeTab === tab}
            className={activeTab === tab ? "active" : ""}
            onClick={() => setActiveTab(tab)}
          >
            {tab === "overview" ? "Overview" : tab === "wallets" ? "Wallets" : tab === "funding" ? "Funding" : "Trade"}
          </button>
        ))}
      </nav>
      {activeTab === "overview" && <>
      <div className="metrics">
        <div className="metric">
          <span>Wallets</span>
          <strong>{wallets.length}</strong>
        </div>
        <div className="metric">
          <span>Bundle range</span>
          <strong>{chosen.length ? `1–${chosen.length}` : "—"}</strong>
        </div>
        <div className="metric">
          <span>Total SOL</span>
          <strong>{total.toFixed(4)}</strong>
        </div>
      </div>
      <section className="card balance-chart">
        <div className="chart-head"><div><div className="ey">LIVE PORTFOLIO</div><h3>All-wallet SOL balance</h3></div><span className="live-dot">● Live · updates continuously</span></div>
        <div className="chart-value">{total.toFixed(4)} <small>SOL</small></div>
        <svg className="chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Total SOL balance across all wallets over time"><polyline points={chartLine || "0,93 100,93"} fill="none" stroke="url(#balanceGradient)" strokeWidth="2.5" vectorEffect="non-scaling-stroke"/><defs><linearGradient id="balanceGradient" x1="0" x2="1"><stop offset="0%" stopColor="#6b4ee4"/><stop offset="100%" stopColor="#3b9af2"/></linearGradient></defs></svg>
        <div className="chart-foot"><span>Wallets 01–{String(wallets.length).padStart(2, "0")}</span><span>{chosen.length ? `Selected range: 01–${String(chosen.length).padStart(2, "0")}` : "No range selected"}</span></div>
      </section>
      </>}
      <div className="grid">
        {activeTab === "wallets" && <section className="card page-card">
          <div className="wallet-controls card-inner">
            <div className="ey">WALLET SETUP</div>
            <h3>Manage wallets and bundle size</h3>
            <p className="muted small">Add sequential wallets, save a backup, then choose how many Wallet 01 through Wallet N to use.</p>
            <div className="wallet-actions">
              <button className="btn secondary" onClick={() => balances()}>
                Refresh
              </button>
              <button className="btn secondary" onClick={backup}>
                Encrypted backup
              </button>
              <label className="add-wallet-field">
                <span>Add wallets</span>
                <div className="add-wallet-combo">
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={addCount}
                    onChange={(e) => setAddCount(e.target.value)}
                    aria-label="Number of wallets to add"
                  />
                  <button type="button" className="inline-add" onClick={add}>
                    Add
                  </button>
                </div>
              </label>
            </div>
            <label className="field">
              <span>Wallets to bundle</span>
              <input
                type="number"
                min="1"
                max={wallets.length}
                value={bundleCount || ""}
                placeholder={`1–${wallets.length}`}
                onChange={(e) => setRange(e.target.value === "" ? 0 : Number(e.target.value))}
              />
              <span className="input-hint">Enter any number from 1 to {wallets.length}; nothing is preselected.</span>
            </label>
            <div className="next-step-card">
              <div>
                <div className="ey">NEXT STEP</div>
                <strong>Fund Wallet 01–N from your master wallet</strong>
                <span>Choose the count here, then set the SOL amount and approve the deposit in Funding.</span>
              </div>
              <button type="button" className="btn secondary" onClick={() => setActiveTab("funding")}>Open Funding</button>
            </div>
          </div>
          <div className="wallets">
            {wallets.map((w) => (
              <button
                className={`wallet ${chosen.some((x) => x.id === w.id) ? "inrange" : ""}`}
                key={w.id}
                onClick={() => inspect(w)}
              >
                <span className="check">
                  {chosen.some((x) => x.id === w.id) ? "✓" : "·"}
                </span>
                <div>
                  <strong>{w.label}</strong>
                  <br />
                  <code>{short(w.pub)}</code>
                </div>
                <div className="bal">
                  <strong>{Number(w.sol || 0).toFixed(4)}</strong>
                  <div className="small muted">SOL</div>
                </div>
              </button>
            ))}
          </div>
        </section>}
        {activeTab === "funding" && <section className="card page-card funding-page">
          <div className="funding card-inner">
            <div className="ey">MASTER DEPOSIT</div>
            <h2>Deposit SOL into mini-wallets</h2>
            <p className="muted small">Choose how many wallets to fund and the amount each receives. Your connected master wallet sends SOL to Wallet 01 through Wallet N in order; the master private key never enters this site.</p>
            <label className="field compact funding-range">
              <span>Wallets to fund</span>
              <input
                type="number"
                min="1"
                max={wallets.length}
                value={fundingCount || ""}
                placeholder={`1–${wallets.length}`}
                onChange={(e) => setFundingCount(e.target.value === "" ? 0 : Math.min(wallets.length, Number(e.target.value)))}
              />
              <span className="input-hint">Funds or withdraws Wallet 01 through Wallet N in sequence.</span>
              <button type="button" className="btn secondary funding-all" onClick={() => setFundingCount(wallets.length)}>Use all {wallets.length} wallets</button>
            </label>
            <label className="field compact"><span>Master wallet address</span><input value={master} onChange={(e) => { setMaster(e.target.value); localStorage.setItem(MASTER_KEY, e.target.value); }} placeholder="Paste the address that should fund and receive wallets" /></label>
            <div className="funding-actions">
              <button className="btn secondary funding-button" onClick={connectMaster}>{master ? `Connect / verify ${short(master)}` : "Connect master wallet"}</button>
              <label className="field compact"><span>SOL to deposit into each wallet</span><input type="number" min="0.000001" step="any" inputMode="decimal" value={fundAmt} onChange={(e) => setFundAmt(e.target.value)} /></label>
            </div>
            <div className="external-wallet-note">
              <strong>External wallet approval</strong>
              <span>On mobile Safari, this opens Phantom for approval and brings you back here. Desktop wallet extensions connect directly.</span>
            </div>
            {masterStatus && <div className="funding-status">{masterStatus}</div>}
            <div className="funding-summary">
              <span>Master debit before network fees</span>
              <strong>{fundTotal.toFixed(6)} SOL</strong>
              <small>{fundingChosen.length ? `${fundingChosen.length} wallet${fundingChosen.length === 1 ? "" : "s"} × ${fundAmt || "0"} SOL` : "Choose a wallet count above"}</small>
            </div>
            <div className="funding-actions">
              <button className="btn" onClick={fundWallets} disabled={funding || !master || !fundAmt || !fundingChosen.length}>{funding ? "Waiting for Phantom approval…" : fundingChosen.length ? `Deposit ${fundTotal.toFixed(6)} SOL into Wallet 01–${String(fundingChosen.length).padStart(2, "0")}` : "Choose wallets to deposit"}</button>
              <button className="btn secondary" onClick={consolidateWallets} disabled={funding || !fundingChosen.length}>{fundingChosen.length ? `Withdraw Wallet 01–${String(fundingChosen.length).padStart(2, "0")} to master` : "Choose wallets to withdraw"}</button>
            </div>
            <div className="input-hint funding-hint">Deposit sends the amount above from the connected master wallet to each selected mini-wallet. Withdraw returns each selected wallet's available SOL, less its network fee reserve, to the master wallet.</div>
            {res.length > 0 && <div className="results">
              {res.map((r, i) => <div className="result" key={`funding-${i}`}>
                <strong className={r.status === "success" ? "ok" : r.status === "skipped" ? "muted" : "bad"}>{r.label}</strong>
                <span>{r.error || r.status}</span>
                {r.sig ? <a target="_blank" href={`https://solscan.io/tx/${r.sig}`}>Solscan ↗</a> : <span />}
              </div>)}
            </div>}
          </div>
        </section>}
        {activeTab === "trade" && <section className="card page-card">
          <div className="ey">BATCH EXECUTION</div>
          <h2>Trade</h2>
          <div className="seg">
            <button
              className={act === "BUY" ? "on" : ""}
              onClick={() => setAct("BUY")}
            >
              BUY
            </button>
            <button
              className={act === "SELL" ? "on sell" : ""}
              onClick={() => setAct("SELL")}
            >
              SELL
            </button>
          </div>
          <label className="field">
            <span>Token mint</span>
            <input
              value={mint}
              onChange={(e) => changeMint(e.target.value)}
              placeholder="Solana token address"
            />
          </label>
          <label className="field">
            <span>Wallets to use for this trade</span>
            <input type="number" min="1" max={wallets.length} value={tradeCount || ""} placeholder={`1–${wallets.length}`} onChange={(e) => setTradeRange(e.target.value === "" ? 0 : Number(e.target.value))} />
            <span className="input-hint">Uses Wallet 01 through Wallet N for this token. Each token keeps its own count.</span>
          </label>
          <div className="seg">
            <button
              className={mode === "FIXED" ? "on" : ""}
              onClick={() => setMode("FIXED")}
            >
              Fixed
            </button>
            <button
              className={mode === "PERCENT" ? "on" : ""}
              onClick={() => setMode("PERCENT")}
            >
              Percent
            </button>
          </div>
          {mode === "FIXED" ? (
            <label className="field">
              <span>
                {act === "BUY" ? "SOL per wallet" : "Tokens per wallet"}
              </span>
              <input value={amt} onChange={(e) => setAmt(e.target.value)} />
            </label>
          ) : (
            <label className="field">
              <span>Percent: {pct}%</span>
              <input
                type="range"
                min="1"
                max="100"
                value={pct}
                onChange={(e) => setPct(Number(e.target.value))}
              />
            </label>
          )}
          <div className="notice small">
            {tradeChosen.length ? (
              <>
                {act === "BUY"
                  ? `Wallet 01 through Wallet ${String(tradeChosen.length).padStart(2, "0")} each get their own Jupiter swap.`
                  : `Wallet 01 through Wallet ${String(tradeChosen.length).padStart(2, "0")} sell simultaneously.`}{" "}
                Up to five execute concurrently. Network and Jupiter fees are taken
                from each wallet’s SOL balance using a small 0.0001 SOL safety
                buffer. Jito MEV protection is enabled for every swap.
              </>
            ) : (
              "Choose how many wallets to bundle above."
            )}
          </div>
          <button
            className={`btn ${act === "SELL" ? "red" : ""}`}
            onClick={() => trade()}
            disabled={busy || !mint || !tradeChosen.length}
          >
            {busy
              ? "Working…"
              : tradeChosen.length
                ? `${act} with first ${tradeChosen.length} wallets`
                : `Choose wallets to ${act.toLowerCase()}`}
          </button>
          {res.length > 0 && (
            <div className="results">
              {res.map((r, i) => (
                <div className="result" key={i}>
                  <strong className={r.status === "success" ? "ok" : r.status === "skipped" ? "muted" : "bad"}>
                    {r.label}
                  </strong>
                  <span>{r.error || r.status}</span>
                  {r.sig ? (
                    <a target="_blank" href={`https://solscan.io/tx/${r.sig}`}>
                      Solscan ↗
                    </a>
                  ) : (
                    <span />
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="positions">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div className="ey">OPEN POSITIONS</div>
              <button className="btn secondary" onClick={recoverPositions} disabled={busy}>Recover from holdings</button>
            </div>
            {positions.length === 0 ? (
              <p className="muted small">
                Successful bundle buys will appear here.
              </p>
            ) : (
              positions.map((p) => (
                <div
                  className="position"
                  key={p.id}
                  onClick={() => preparePosition(p)}
                >
                  <span>
                    <strong>{short(p.mint)}</strong>
                    <small>{p.walletIds.length} wallets · click to load</small>
                  </span>
                  <button className="quick-sell" onClick={(e) => { e.stopPropagation(); quickSell(p); }}>Quick sell ↗</button>
                </div>
              ))
            )}
          </div>
        </section>}
      </div>
      <div className="footer">
        Click any wallet to inspect holdings, deposit to its address, or
        withdraw SOL. Export the encrypted vault before funding wallets.
      </div>
      {detail && (
        <div className="modalback" onClick={() => setDetail(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <button className="close" onClick={() => setDetail(null)}>
              ×
            </button>
            <div className="ey">{detail.label}</div>
            <h2>Wallet details</h2>
            <code className="address">{detail.pub}</code>
            <div className="deposit">
              <strong>Deposit</strong>
              <p>Send SOL or tokens to this wallet address:</p>
              <code>{detail.pub}</code>
              <button
                className="btn secondary"
                onClick={() => navigator.clipboard?.writeText(detail.pub)}
              >
                Copy address
              </button>
            </div>
            <div className="holdings">
              <strong>Holdings</strong>
              {!holdings ? (
                <p className="muted">Loading live holdings…</p>
              ) : (
                <>
                  <div className="holding">
                    <span>SOL</span>
                    <b>{holdings.sol}</b>
                  </div>
                  {holdings.tokens.length === 0 ? (
                    <p className="muted small">No SPL token holdings.</p>
                  ) : (
                    holdings.tokens.map((t) => (
                      <div className="holding" key={t.mint}>
                        <span>{short(t.mint)}</span>
                        <b>{t.uiAmount}</b>
                      </div>
                    ))
                  )}
                </>
              )}
            </div>
            <div className="withdraw">
              <strong>Withdraw SOL</strong>
              <input
                placeholder="Destination wallet address"
                value={dest}
                onChange={(e) => setDest(e.target.value)}
              />
              <input
                placeholder="SOL amount"
                value={withdrawAmt}
                onChange={(e) => setWithdrawAmt(e.target.value)}
              />
              <button
                className="btn red"
                disabled={busy || !dest || !withdrawAmt}
                onClick={withdraw}
              >
                Withdraw from {detail.label}
              </button>
            </div>
            <button
              className="btn danger-outline delete-wallet"
              onClick={removeWallet}
            >
              Delete {detail.label}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

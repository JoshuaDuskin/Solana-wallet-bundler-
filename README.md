# Solana Wallet Bundler

A Next.js multi-wallet Solana execution dashboard designed for 25+ wallets.

This repository is open source under the MIT License. You can fork it, copy it, modify it, and deploy your own instance.

## Contract address

**Solana contract address**

`BdDLafF6rHx4dwayzibzAkj4xzea99xLcYmAk1Prpump`

[View on Pump.fun](https://pump.fun/coin/BdDLafF6rHx4dwayzibzAkj4xzea99xLcYmAk1Prpump?share)

Always verify the contract address from this repository before interacting with the token.

## Hosted architecture

- Wallet keypairs are generated **inside the browser**.
- The browser vault is encrypted with PBKDF2-SHA256 + AES-256-GCM.
- Raw private keys are never sent to GitHub, Vercel, Jupiter, or the API routes.
- Vercel/server routes handle public Solana RPC reads and proxy Jupiter Swap V2 requests.
- Jupiter returns the transaction, the browser signs it locally, then only the signed transaction is sent back for execution.

## Features

- Create 25 wallets during first-run setup.
- Add up to 100 wallets per creation batch.
- Import existing Solana secret keys into the encrypted browser vault.
- Select any subset of wallets.
- View SOL and token balances.
- Batch BUY/SELL through Jupiter.
- Fixed amount or percentage sizing.
- Bounded concurrency for execution.
- Encrypted vault backup download/import.
- Public-address CSV export.
- Solscan links for successful transactions.
- Master-wallet funding and consolidation controls.

## Environment variables

Create your own credentials. No API key, RPC credential, wallet private key, or seed phrase is included in this repository.

Set these locally in `.env.local` and in your deployment provider's environment-variable settings:

```env
JUPITER_API_KEY=your_jupiter_api_key
SOLANA_RPC_URL=your_private_solana_rpc_url
```

`JUPITER_API_KEY` is required for Jupiter requests. `SOLANA_RPC_URL` is strongly recommended for 25+ wallets; without it the app falls back to Solana's public mainnet RPC and may be rate-limited.

Never commit a populated `.env` or `.env.local` file.

## Local development

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

## Deploy your own copy

1. Fork or clone this repository.
2. Install dependencies with `npm install`.
3. Add your own `JUPITER_API_KEY` and `SOLANA_RPC_URL`.
4. Deploy the Next.js app to Vercel or another compatible host.
5. Create a fresh encrypted wallet vault in your own browser.

Do not reuse another person's wallet vault, private keys, RPC credentials, or API credentials.

## Security model

The repository itself contains no wallet private keys. Wallet secrets are generated or imported in the browser and stored in the encrypted browser vault. Export the encrypted vault before funding wallets and keep its password separately.

This software can sign and submit real Solana transactions. Review the code, test with small amounts, protect your vault backup, and use your own credentials before using it with meaningful funds.

## License

MIT License. See [LICENSE](LICENSE).

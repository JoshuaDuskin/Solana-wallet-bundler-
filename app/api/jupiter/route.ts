import { NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { errorResponse, isBase64, json, readJson, rejectIfUnsafe } from "../_security";
export const runtime="nodejs"; export const dynamic="force-dynamic";
const base="https://api.jup.ag/swap/v2";
const jito="https://mainnet.block-engine.jito.wtf/api/v1/transactions";
async function jf(path:string,init?:RequestInit){const key=process.env.JUPITER_API_KEY;if(!key)throw Error("Jupiter is not configured");let last=0;for(let attempt=0;attempt<3;attempt++){const h=new Headers(init?.headers);h.set("x-api-key",key);if(init?.body)h.set("content-type","application/json");const r=await fetch(base+path,{...init,headers:h,cache:"no-store"});const t=await r.text();if(r.ok)return t?JSON.parse(t):{};last=r.status;if(r.status!==429&&r.status<500)break;const retry=Number(r.headers.get("retry-after")||0);await new Promise((resolve)=>setTimeout(resolve,Math.max(retry*1000,250*(attempt+1))));}throw Error(`Jupiter request failed (${last})`)}
function validAddress(value: unknown) { if (typeof value !== "string" || value.length > 64) return false; try { new PublicKey(value); return true; } catch { return false; } }
export async function POST(r:NextRequest){
  const blocked=rejectIfUnsafe(r,"jupiter",30); if(blocked)return blocked;
  try{
    const b=await readJson<any>(r);
    if(b.action==="order"){
      if(!validAddress(b.inputMint)||!validAddress(b.outputMint)||b.inputMint===b.outputMint)throw Error("Invalid swap mints");
      if(!/^[1-9]\d*$/.test(String(b.amount))||String(b.amount).length>30)throw Error("Invalid swap amount");
      if(b.taker!==undefined&&!validAddress(b.taker))throw Error("Invalid taker wallet");
      const q=new URLSearchParams({inputMint:b.inputMint,outputMint:b.outputMint,amount:String(b.amount)});if(b.taker)q.set("taker",b.taker);return json(await jf(`/order?${q}`));
    }
    if(b.action==="execute"){
      if(!isBase64(b.signedTransaction)||typeof b.requestId!=="string"||b.requestId.length>200)throw Error("Invalid signed transaction request");
      if(b.mevProtected){const jr=await fetch(process.env.JITO_BLOCK_ENGINE_URL||jito,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"sendTransaction",params:[b.signedTransaction,{encoding:"base64"}]})});const jj=await jr.json();if(!jr.ok||jj.error)throw Error("MEV-protected transaction failed");return json({status:"Success",signature:jj.result,mevProtected:true})}
      return json(await jf("/execute",{method:"POST",body:JSON.stringify({signedTransaction:b.signedTransaction,requestId:b.requestId,lastValidBlockHeight:b.lastValidBlockHeight})}));
    }
    throw Error("Unknown action");
  }catch(e){return errorResponse(e)}
}

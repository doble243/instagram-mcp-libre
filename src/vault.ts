import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function key() {
  const raw=process.env.TOKEN_ENCRYPTION_KEY??"";
  if(!raw) throw new Error("Define TOKEN_ENCRYPTION_KEY (32 bytes, hexadecimal) para guardar tokens OAuth cifrados.");
  if(!/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error("TOKEN_ENCRYPTION_KEY debe tener exactamente 64 caracteres hexadecimales.");
  const decoded=Buffer.from(raw,"hex");
  if(decoded.length!==32) throw new Error("TOKEN_ENCRYPTION_KEY debe tener exactamente 64 caracteres hexadecimales.");
  return decoded;
}
export function encryptToken(value: string) {
  const iv=randomBytes(12); const cipher=createCipheriv("aes-256-gcm",key(),iv);
  const encrypted=Buffer.concat([cipher.update(value,"utf8"),cipher.final()]);
  return [iv.toString("hex"),cipher.getAuthTag().toString("hex"),encrypted.toString("hex")].join(".");
}
export function decryptToken(value: string) {
  const [iv,tag,data]=value.split("."); if(!iv||!tag||!data) throw new Error("Formato de token cifrado inválido.");
  const decipher=createDecipheriv("aes-256-gcm",key(),Buffer.from(iv,"hex")); decipher.setAuthTag(Buffer.from(tag,"hex"));
  return Buffer.concat([decipher.update(Buffer.from(data,"hex")),decipher.final()]).toString("utf8");
}

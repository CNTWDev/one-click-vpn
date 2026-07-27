import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  createCertificateIssuance,
  createCredentialAuthority,
  findActiveCertificateIssuance,
  findActiveCredentialAuthority,
  listRevokedCertificateSerials,
  revokeCertificateIssuance,
  type CertificateIssuance,
  type CredentialAuthority,
} from "./control-db";
import { createSecretMaterial, findSecretMaterialByKind, readSecretMaterial } from "./secret-materials";

const execFileAsync = promisify(execFile);
const OPENVPN_REALM = "northstar-managed";
const OPENVPN_PROTOCOL = "openvpn" as const;
const OPENVPN_CA_DAYS = 3650;
const OPENVPN_LEAF_DAYS = 825;

function createTlsCryptKey(): string {
  const hex = randomBytes(256).toString("hex");
  const rows = hex.match(/.{1,64}/g) || [];
  return ["-----BEGIN OpenVPN Static key V1-----", ...rows, "-----END OpenVPN Static key V1-----", ""].join("\n");
}

function certificateDate(days: number): { notBefore: string; notAfter: string } {
  const notBefore = new Date();
  const notAfter = new Date(notBefore.getTime() + days * 24 * 60 * 60 * 1000);
  return { notBefore: notBefore.toISOString(), notAfter: notAfter.toISOString() };
}

function safeCommonName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 56) || "northstar";
}

async function openssl(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("openssl", args, { cwd, maxBuffer: 1024 * 1024 });
  return stdout;
}

async function withWorkspace<T>(callback: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), "northstar-openvpn-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function issueCertificate(input: {
  authority: CredentialAuthority;
  purpose: "server" | "client";
  commonName: string;
  ownerNodeId?: string;
}): Promise<{ certificatePem: string; privateKeyPem: string; serial: string; notBefore: string; notAfter: string }> {
  const caPrivateKey = await readSecretMaterial(input.authority.private_key_secret_id);
  if (!caPrivateKey) throw new Error("OpenVPN issuer private key is unavailable");
  const dates = certificateDate(OPENVPN_LEAF_DAYS);
  return withWorkspace(async (directory) => {
    await Promise.all([
      writeFile(path.join(directory, "ca.crt"), input.authority.certificate_pem, { mode: 0o600 }),
      writeFile(path.join(directory, "ca.key"), caPrivateKey, { mode: 0o600 }),
    ]);
    await openssl(["genrsa", "-out", "leaf.key", "2048"], directory);
    await openssl(["req", "-new", "-key", "leaf.key", "-out", "leaf.csr", "-subj", `/CN=${safeCommonName(input.commonName)}`], directory);
    const extendedKeyUsage = input.purpose === "server" ? "serverAuth" : "clientAuth";
    await writeFile(path.join(directory, "leaf.ext"), [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      `extendedKeyUsage=${extendedKeyUsage}`,
      "subjectKeyIdentifier=hash",
      "authorityKeyIdentifier=keyid,issuer",
    ].join("\n"), { mode: 0o600 });
    await openssl([
      "x509", "-req", "-in", "leaf.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial",
      "-out", "leaf.crt", "-days", String(OPENVPN_LEAF_DAYS), "-sha256", "-extfile", "leaf.ext",
    ], directory);
    const [certificatePem, privateKeyPem, serialOutput] = await Promise.all([
      readFile(path.join(directory, "leaf.crt"), "utf8"),
      readFile(path.join(directory, "leaf.key"), "utf8"),
      openssl(["x509", "-in", "leaf.crt", "-noout", "-serial"], directory),
    ]);
    const serial = serialOutput.trim().replace(/^serial=/i, "").toUpperCase();
    if (!/^[A-F0-9]+$/.test(serial)) throw new Error("OpenVPN certificate serial is invalid");
    return { certificatePem, privateKeyPem, serial, ...dates };
  });
}

export async function ensureOpenVpnAuthority(): Promise<CredentialAuthority> {
  const existing = await findActiveCredentialAuthority(OPENVPN_REALM, OPENVPN_PROTOCOL);
  if (existing) return existing;
  if (!process.env.NORTHSTAR_MASTER_KEY) throw new Error("NORTHSTAR_MASTER_KEY is required before creating OpenVPN credentials");
  const dates = certificateDate(OPENVPN_CA_DAYS);
  const material = await withWorkspace(async (directory) => {
    await openssl(["genrsa", "-out", "ca.key", "3072"], directory);
    await openssl([
      "req", "-x509", "-new", "-nodes", "-key", "ca.key", "-sha256", "-days", String(OPENVPN_CA_DAYS),
      "-out", "ca.crt", "-subj", "/CN=Northstar Managed OpenVPN CA",
      "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    ], directory);
    const tlsCryptKey = createTlsCryptKey();
    return {
      certificatePem: await readFile(path.join(directory, "ca.crt"), "utf8"),
      privateKeyPem: await readFile(path.join(directory, "ca.key"), "utf8"),
      tlsCryptKey,
    };
  });
  const privateKey = await createSecretMaterial({ kind: "openvpn_ca_private_key", value: material.privateKeyPem });
  const tlsCrypt = await createSecretMaterial({ kind: "openvpn_tls_crypt_key", value: material.tlsCryptKey });
  return createCredentialAuthority({
    realm: OPENVPN_REALM,
    protocol: OPENVPN_PROTOCOL,
    certificate_pem: material.certificatePem,
    private_key_secret_id: privateKey.id,
    tls_crypt_secret_id: tlsCrypt.id,
    not_before: dates.notBefore,
    not_after: dates.notAfter,
  });
}

export async function ensureOpenVpnServerBundle(nodeId: string, nodeName: string) {
  const authority = await ensureOpenVpnAuthority();
  let issuance = await findActiveCertificateIssuance({ authorityId: authority.id, nodeId, purpose: "server" });
  if (!issuance) {
    const issued = await issueCertificate({ authority, purpose: "server", commonName: `northstar-node-${nodeName}`, ownerNodeId: nodeId });
    const privateKey = await createSecretMaterial({ kind: "openvpn_server_private_key", value: issued.privateKeyPem, ownerNodeId: nodeId });
    issuance = await createCertificateIssuance({
      authority_id: authority.id, node_id: nodeId, device_id: null, purpose: "server", serial: issued.serial,
      subject: `CN=northstar-node-${safeCommonName(nodeName)}`, certificate_pem: issued.certificatePem,
      private_key_secret_id: privateKey.id, not_before: issued.notBefore, not_after: issued.notAfter,
    });
  }
  const existingBundle = await findSecretMaterialByKind("openvpn_server_bundle", nodeId);
  if (existingBundle) return { authority, issuance, bundleSecretId: existingBundle.id };
  const [serverPrivateKey, tlsCryptKey] = await Promise.all([
    issuance.private_key_secret_id ? readSecretMaterial(issuance.private_key_secret_id) : undefined,
    authority.tls_crypt_secret_id ? readSecretMaterial(authority.tls_crypt_secret_id) : undefined,
  ]);
  if (!serverPrivateKey || !tlsCryptKey) throw new Error("OpenVPN server key material is unavailable");
  const bundle = await createSecretMaterial({
    kind: "openvpn_server_bundle",
    ownerNodeId: nodeId,
    value: JSON.stringify({
      caCertificate: authority.certificate_pem,
      serverCertificate: issuance.certificate_pem,
      serverPrivateKey,
      tlsCryptKey,
    }),
  });
  return { authority, issuance, bundleSecretId: bundle.id };
}

export async function ensureOpenVpnClientCredential(deviceId: string, rotate = false): Promise<{ authority: CredentialAuthority; issuance: CertificateIssuance }> {
  const authority = await ensureOpenVpnAuthority();
  const commonName = safeCommonName(`northstar-${deviceId}`);
  let issuance = await findActiveCertificateIssuance({ authorityId: authority.id, deviceId, purpose: "client" });
  if (issuance && (rotate || issuance.subject !== `CN=${commonName}`)) {
    await revokeCertificateIssuance(issuance.id);
    issuance = undefined;
  }
  if (!issuance) {
    const issued = await issueCertificate({ authority, purpose: "client", commonName });
    const privateKey = await createSecretMaterial({ kind: "openvpn_client_private_key", value: issued.privateKeyPem });
    issuance = await createCertificateIssuance({
      authority_id: authority.id, node_id: null, device_id: deviceId, purpose: "client", serial: issued.serial,
      subject: `CN=${commonName}`, certificate_pem: issued.certificatePem,
      private_key_secret_id: privateKey.id, not_before: issued.notBefore, not_after: issued.notAfter,
    });
  }
  return { authority, issuance };
}

export async function openVpnRevokedSerials(): Promise<string[]> {
  const authority = await ensureOpenVpnAuthority();
  return listRevokedCertificateSerials(authority.id);
}

export async function renderOpenVpnProfile(input: { endpoint: { host: string; port: number }; transport: string; dns: string[]; payload: Record<string, unknown> }): Promise<string> {
  const certificate = typeof input.payload.clientCertificate === "string" ? input.payload.clientCertificate : "";
  const caCertificate = typeof input.payload.caCertificate === "string" ? input.payload.caCertificate : "";
  const clientKeySecretId = typeof input.payload.clientKeySecretId === "string" ? input.payload.clientKeySecretId : "";
  const tlsCryptSecretId = typeof input.payload.tlsCryptSecretId === "string" ? input.payload.tlsCryptSecretId : "";
  if (!certificate || !caCertificate || !clientKeySecretId || !tlsCryptSecretId) throw new Error("OpenVPN profile credentials are incomplete");
  const [clientKey, tlsCryptKey] = await Promise.all([readSecretMaterial(clientKeySecretId), readSecretMaterial(tlsCryptSecretId)]);
  if (!clientKey || !tlsCryptKey) throw new Error("OpenVPN profile private key material is unavailable");
  const proto = input.transport === "tcp" ? "tcp-client" : "udp";
  const dnsLines = input.dns.map((dns) => `dhcp-option DNS ${dns}`);
  return [
    "client", "dev tun", `proto ${proto}`, `remote ${input.endpoint.host} ${input.endpoint.port}`, "nobind", "persist-key", "persist-tun",
    "remote-cert-tls server", "auth-nocache", "auth SHA256", "data-ciphers AES-256-GCM:CHACHA20-POLY1305", "data-ciphers-fallback AES-256-GCM",
    "verb 3", ...dnsLines, "<ca>", caCertificate.trim(), "</ca>", "<cert>", certificate.trim(), "</cert>", "<key>", clientKey.trim(), "</key>", "<tls-crypt>", tlsCryptKey.trim(), "</tls-crypt>", "",
  ].join("\n");
}

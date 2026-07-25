# Northstar Control Plane

Northstar is a single-machine control-plane interface for operating a global VPN fleet. The first product surface focuses on the operating model rather than generic monitoring:

- add a server with its public IP and temporary SSH credential;
- seal that recovery credential instead of displaying it again;
- bootstrap a node into an outbound mTLS Agent channel;
- operate normal terminal sessions over the Agent channel;
- retain encrypted emergency SSH as an explicit, audited fallback.

## Product boundary

This repository currently contains the interactive control-plane UI and its local state model. It intentionally does **not** execute SSH commands or accept production credentials yet. Real SSH bootstrap, credential encryption, RBAC, MFA, terminal recording, and the node Agent belong in the controller runtime before this interface is connected to a real fleet.

## Run locally

```bash
npm install
npm run dev
```

Then open the local URL printed by the development server.

## Verify

```bash
npm run build
npm test
```

## Intended controller architecture

The production controller remains a single-machine deployment:

```text
vpn-control (one process)
  ├── Web UI + API + HTTPS
  ├── SQLite
  ├── encrypted recovery-credential store
  ├── task runner and audit log
  └── mTLS Agent gateway
```

Nodes use a small outbound Agent. The Agent becomes the normal management and terminal route; direct SSH with a sealed emergency credential is a controlled fallback when the Agent is unreachable.
# one-click-vpn

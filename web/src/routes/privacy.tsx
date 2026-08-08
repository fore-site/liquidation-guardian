import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "../components/LegalPage.js";

/** Privacy policy — brief, honest, no legal boilerplate. */
export const Route = createFileRoute("/privacy")({
  component: () => <LegalPage title="Privacy" body={BODY} />,
});

const BODY = `
Liquidation Guardian is a demo agent that monitors Aave positions and executes
rescues through KeeperHub. This page explains what data the service holds and
why.

## What we store

- Your KeeperHub API key, encrypted at rest (AES-256-GCM) on the server. It is
  used only to authenticate requests to KeeperHub on your behalf.
- Your wallet address, used to read your position's health factor.
- Your threshold and target settings.
- A session cookie naming your stored record. It is HttpOnly and expires after
  30 days.

## What never leaves the server

The decrypted API key never reaches a browser, a chat message, or a third
party. The dashboard and Telegram bot only ever receive public data: health
factors, amounts, and transaction links.

## What we do not do

We do not sell data. We do not track you across sites. We do not hold your
private keys — the agent carries limited execution permission scoped to
repaying debt or adding collateral on your position.

## Deleting your data

"Stop watching" on the dashboard, or /stop in the Telegram bot, permanently
deletes your stored record and encrypted key.

## Contact

Questions about this policy: open an issue in the project repository.
`;

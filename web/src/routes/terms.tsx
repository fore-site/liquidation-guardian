import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "../components/LegalPage.js";

/** Terms of use — plain language, demo scope. */
export const Route = createFileRoute("/terms")({
  component: () => <LegalPage title="Terms" body={BODY} />,
});

const BODY = `
Liquidation Guardian is provided as a demonstration project. Use it on testnets
and at your own risk.

## What this is

An agent that watches Aave positions and can execute rescues through KeeperHub.
It is not financial advice and not a guarantee against liquidation.

## Execution

Every write is simulated before broadcast, and each transaction is executed
through KeeperHub with retries and an audit trail. On testnets, gas is
sponsored by KeeperHub. Nothing in this project is a promise that a rescue
will always succeed.

## Your responsibility

- Keep your KeeperHub key safe. Anyone with it can act on your position.
- Review the one-tap approvals the Telegram bot sends before tapping.
- Test on Sepolia before considering any production use.

## Liability

This software is provided as is, without warranty of any kind. In no event
shall the authors be liable for any claim, damages, or other liability arising
from the use of this software, including losses from liquidated positions.
`;

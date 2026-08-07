import { createFileRoute } from "@tanstack/react-router";
import { Onboarding } from "../components/Onboarding.js";

/** Onboarding form — collects the KeeperHub key + wallet + defense profile. */
export const Route = createFileRoute("/start")({
  component: Onboarding,
});

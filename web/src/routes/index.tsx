import { createFileRoute } from "@tanstack/react-router";
import { Landing } from "../components/Landing.js";

/** Marketing landing — SSR'd for first paint/SEO; links to /start. */
export const Route = createFileRoute("/")({
  component: Landing,
});

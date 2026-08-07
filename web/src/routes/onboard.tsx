import { useNavigate } from "@tanstack/react-router";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { getSession } from "../api.js";
import { Onboarding } from "../components/Onboarding.js";

/**
 * Onboarding form — collects the KeeperHub key + wallet + defense profile. A
 * user who already has a live session is redirected straight to the dashboard
 * (they can still disconnect from there). The check runs client-side after
 * hydration — `beforeLoad` executes server-side where the session cookie isn't
 * reliably attached to the server-fn call.
 */
export const Route = createFileRoute("/onboard")({
  component: StartPage,
});

function StartPage() {
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    getSession()
      .then((s) => {
        if (!cancelled && s.authenticated) void navigate({ to: "/dashboard" });
      })
      .catch(() => undefined); // a failed read just shows onboarding
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  return <Onboarding />;
}

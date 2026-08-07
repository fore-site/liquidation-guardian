import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getTelegramLink, unbindTelegram } from "../api.js";
import { Button } from "./ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card.js";

/**
 * Telegram connection card for the dashboard. Shows the bound status and lets the
 * user:
 *  - connect: generates a one-time code + builds a t.me deep link; tapping it
 *    opens the bot with /start link_<code>, which binds the chat to this record.
 *  - unbind: removes the Telegram binding (the dashboard keeps watching).
 */
export function TelegramLink({
  boundUsername,
  onChanged,
}: {
  boundUsername?: string | null;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();

  const link = useMutation({
    mutationFn: getTelegramLink,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["session"] });
    },
  });

  const unbind = useMutation({
    mutationFn: unbindTelegram,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["session"] });
      onChanged();
    },
  });

  const bound = boundUsername != null && boundUsername.length > 0;
  const deepLink =
    link.data?.code && link.data?.botUsername
      ? `https://t.me/${link.data.botUsername}?start=link_${link.data.code}`
      : null;

  return (
    <Card className="bg-card">
      <CardHeader>
        <CardTitle className="text-lg">Telegram alerts</CardTitle>
        <CardDescription>
          {bound
            ? `Bound to @${boundUsername} — the bot pushes alerts and one-tap rescues here.`
            : "Get alerts + one-tap rescues in Telegram."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {bound ? (
          <Button variant="outline" size="sm" onClick={() => unbind.mutate()} disabled={unbind.isPending}>
            {unbind.isPending ? "Unbinding…" : "Unbind Telegram"}
          </Button>
        ) : deepLink ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Tap below, then send <span className="font-mono text-foreground">/start</span> in the
              bot chat to connect.
            </p>
            <Button asChild size="sm">
              <a href={deepLink} target="_blank" rel="noopener noreferrer">
                Connect Telegram
              </a>
            </Button>
            <p className="text-xs text-muted-foreground">
              Code <span className="font-mono text-foreground">{link.data!.code}</span> — expires in
              5 minutes.
            </p>
          </div>
        ) : (
          <Button size="sm" onClick={() => link.mutate()} disabled={link.isPending}>
            {link.isPending ? "Generating…" : "Connect Telegram"}
          </Button>
        )}
        {link.isError && (
          <p className="text-xs text-risk">{link.error instanceof Error ? link.error.message : "Couldn't create link"}</p>
        )}
      </CardContent>
    </Card>
  );
}

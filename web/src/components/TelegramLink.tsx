import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getTelegramLink, unbindTelegram } from "../api.js";
import { Button } from "./ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.js";

export function TelegramLink({ boundUsername, connected = false, onChanged }: { boundUsername?: string | null; connected?: boolean; onChanged: () => void }) {
  const queryClient = useQueryClient();
  const link = useMutation({ mutationFn: getTelegramLink, onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["session"] }); } });
  const unbind = useMutation({ mutationFn: unbindTelegram, onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["session"] }); onChanged(); } });
  const bound = connected || (boundUsername != null && boundUsername.length > 0);
  const account = boundUsername ? `@${boundUsername}` : "your Telegram account";
  const deepLink = link.data?.code && link.data?.botUsername ? `https://t.me/${link.data.botUsername}?start=link_${link.data.code}` : null;
  return <Card><CardHeader><p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">Notifications</p><CardTitle>Telegram alerts</CardTitle></CardHeader><CardContent className="space-y-4">{bound ? <><p className="text-sm text-muted-foreground">Connected to {account}.</p><Button variant="outline" size="sm" onClick={() => unbind.mutate()} disabled={unbind.isPending}>{unbind.isPending ? "Unbinding…" : "Unbind Telegram"}</Button></> : deepLink ? <><p className="text-sm text-muted-foreground">Open the bot, then send <span className="font-mono text-foreground">/start</span> to connect.</p><Button asChild size="sm"><a href={deepLink} target="_blank" rel="noopener noreferrer">Connect Telegram</a></Button><p className="text-xs text-muted-foreground">Code <span className="font-mono text-foreground">{link.data!.code}</span> expires in 5 minutes.</p></> : <Button size="sm" onClick={() => link.mutate()} disabled={link.isPending}>{link.isPending ? "Generating…" : "Connect Telegram"}</Button>}{link.isError && <p className="text-xs text-risk">{link.error instanceof Error ? link.error.message : "Could not create the link."}</p>}</CardContent></Card>;
}

/**
 * Network bootstrap — import for its side effect, first thing in every entrypoint.
 *
 * Node's fetch (undici) uses "Happy Eyeballs" to race IPv6 and IPv4 with a 250 ms
 * per-attempt failover. On networks where IPv6 is advertised but silently dropped
 * (many corporate/VPN/sandbox setups), that 250 ms isn't enough to fail over to
 * IPv4 before the socket hangs — so fetch times out even though curl, which fails
 * over more patiently, connects fine. Raising the attempt timeout fixes it with no
 * downside on healthy networks.
 */
import net from "node:net";

net.setDefaultAutoSelectFamilyAttemptTimeout(2000);

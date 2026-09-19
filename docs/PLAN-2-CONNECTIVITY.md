# Plan 2 — Connectivity: SSH Tunnels, Bastions, and AWS SSM

**Companion to PLAN.md.** Covers how the client reaches databases that aren't directly routable.

*Drafted 2026-09-17. Crate versions and AWS behaviour verified against docs.rs and AWS documentation on that date.*

---

## 0. Why this is the whole ballgame

Your screenshot tells the real story:

```
Port 15432 opened for SessionId om.dwivedi@...
Waiting for connections...
Connection accepted for session [...]

Exiting session with sessionId: om.dwivedi@...
```

That's AWS SSM Session Manager forwarding a private RDS Postgres to `localhost:15432` — and then **exiting**. Every time that happens, your DB client's connection pool is holding sockets to a port that no longer forwards anywhere. TablePlus doesn't notice; it just starts throwing errors until you restart the tunnel in a terminal and reconnect by hand.

So this isn't really a feature request for "SSH support." It's two separate problems:

1. **Own the tunnel** — the app establishes it, so there's no second terminal window to babysit
2. **Survive the tunnel dying** — because with SSM it *will* die, and that's the part nobody gets right

The second is where the real value is, and I'll come back to it in §4 because there's a specific AWS behaviour that makes it unavoidable.

**Competitive position, which is better than I expected:**

| Tool | Classic SSH | AWS SSM | RDS IAM auth |
|---|---|---|---|
| TablePlus | Yes | **No** — [#3464](https://github.com/TablePlus/TablePlus/issues/3464) open since Dec 2024 | No (paste tokens by hand) |
| Beekeeper Studio | Yes | No | No |
| DBeaver CE | Yes | **No** | No |
| DBeaver Lite/EE | Yes | Yes (shells out to AWS CLI + plugin) | Yes |
| DataGrip | Yes | No ([DBE-9500](https://youtrack.jetbrains.com/issue/DBE-9500) open) | Partial |

Native SSM in a *free, open-source* client doesn't currently exist. That's your wedge.

---

## 1. The Transport abstraction

Tunnelling must sit **below** the `Driver` trait from PLAN.md, not inside each driver. Otherwise you implement SSH five times.

```rust
#[async_trait]
pub trait Transport: Send + Sync {
    /// Establish and return the local endpoint drivers should dial.
    async fn establish(&mut self) -> Result<SocketAddr>;

    /// Is the tunnel actually carrying traffic right now?
    async fn health(&self) -> TransportHealth;

    async fn teardown(&mut self) -> Result<()>;

    /// Fires when the tunnel dies unexpectedly.
    fn on_dropped(&self) -> broadcast::Receiver<DropReason>;
}

pub enum TransportKind {
    Direct,
    SshTunnel(SshConfig),
    Ssm(SsmConfig),
    CloudSqlProxy(CloudSqlConfig),   // later
}
```

Connection flow becomes: resolve profile → `Transport::establish()` → returns `127.0.0.1:PORT` → driver connects there → pool registers itself with the tunnel supervisor.

**The driver must never know it's tunnelled.** One exception, and it's a real one: RDS IAM auth signs the token against the *actual* RDS endpoint, not `localhost` — see §5.

**Bind to `127.0.0.1`, never `0.0.0.0`.** Binding a forwarded production database to all interfaces on a laptop on café wifi is an incident waiting to happen. Also **allocate port 0 and let the OS choose**, then tell the driver the real port. Hardcoding 15432 breaks the moment you open two connections to different environments, and collides with the terminal session the user may already have running.

---

## 2. Classic SSH tunnels

### Crate choice

`russh` **0.63.3** — pure Rust, Tokio-native, no libssh2 C dependency.

The method you need on `russh::client::Handle`:

```rust
let channel = handle.channel_open_direct_tcpip(
    "db.internal",       // host_to_connect
    5432,                // port_to_connect
    "127.0.0.1",         // originator_address
    local_port,          // originator_port
).await?;
```

That's `ssh -L` in one call. Then pump bytes between the accepted `TcpStream` and the channel with `tokio::io::copy_bidirectional`. There's also `channel_open_direct_streamlocal` if you ever need to reach a database over a Unix socket on the remote host — Postgres installs often only listen there.

### Auth methods — all of them, not just keys

This is where DB clients usually disappoint. `russh` supports the full set:

| Method | API | Notes |
|---|---|---|
| Password | `authenticate_password` | |
| Public key | `authenticate_publickey` | RSA, Ed25519, ECDSA P-256/384/521 |
| **ssh-agent** | `authenticate_publickey_with` + `AgentClient::connect_env()` | **Ship this first** |
| Keyboard-interactive | `authenticate_keyboard_interactive_start` / `_respond` | This is how you get 2FA/MFA support |
| OpenSSH certs | `authenticate_openssh_cert` | Common at companies using Vault/Teleport |

**ssh-agent support is the one that matters most and is most often missing.** Corporate setups routinely use agent-forwarded, hardware-backed (YubiKey), or short-lived certificate keys where there simply is no private key file to point a file-picker at. `AgentClient::connect_env()` reads `SSH_AUTH_SOCK` and it just works.

**Keyboard-interactive is how you support 2FA.** The server sends prompts; you show them in a modal; the user types their TOTP. Without it, anyone whose bastion requires MFA cannot use your app at all.

Passphrase-protected keys: `russh::keys::load_secret_key(path, Some(passphrase))`. Prompt for the passphrase, offer to cache it in the keychain, never write it to the profile DB.

### Read `~/.ssh/config`

Use `ssh2-config` **0.8.0**. It handles `Host` patterns, `HostName`, `User`, `Port`, `IdentityFile`, `ProxyJump` (since 0.6.2) and `Include` (since 0.4.0).

This is a genuine differentiator and it's cheap. TablePlus does *not* honour `~/.ssh/config` — that's the root cause of its open SSM issue, since the standard SSM workaround is a `ProxyCommand` entry in ssh config. If a user has already written:

```
Host prod-bastion
  HostName i-0abc123
  User ec2-user
  ProxyCommand sh -c "aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p"
```

...then "import from ssh config" makes their connection work in one click. Support `ProxyCommand` by actually spawning the command and speaking SSH over its stdio — `russh-config` has helpers for exactly this.

### Multi-hop

`ProxyJump` chains are normal in production. Implement recursively: open a `direct-tcpip` channel to the next hop through the previous hop's session, and run a fresh SSH client over that channel. Two hops covers ~99% of real setups; make the config a `Vec<SshHop>` anyway so three costs nothing.

### Keepalive

Send SSH keepalives every 30s (`ServerAliveInterval` equivalent) and treat 3 missed responses as a drop. Many bastions have aggressive idle timeouts and will silently drop a tunnel that's only carrying an idle connection pool.

---

## 3. AWS SSM — the part that needs a decision

### The unavoidable constraint

`aws ssm start-session` does **not** do the tunnelling. The CLI only calls the `StartSession` API and hands the returned token and WebSocket URL to a separate Go binary, **`session-manager-plugin`**. The plugin does all the real work, and **AWS does not publicly document the WebSocket data-channel protocol** — the Apache-2.0 source is the only spec, with no stability guarantee.

Three options:

| Option | Effort | Risk | Verdict |
|---|---|---|---|
| **A. Shell out to `session-manager-plugin`** | Low | Users must install it; you parse its stdout | **Ship this** |
| **B. Port the protocol to Rust** | High | You own an undocumented protocol AWS can change | Phase 2 experiment |
| **C. Bundle the Go binary** | Medium | +~10MB × 3 platforms, redistribution questions | Only if install friction proves fatal |

Go with **A**, and design so **B** can slot in later behind the same `Transport` impl.

This is precisely what DBeaver does — its AWS SSM handler requires you to configure paths to both the AWS CLI and the Session Manager Plugin. If the mature paid tool shells out, that's a strong signal it's the right call. The difference is that you'll do it for free and handle reconnection properly.

There is prior art for option B: [`mmmorris1975/ssm-session-client`](https://github.com/mmmorris1975/ssm-session-client) (Go, MIT) reimplements the protocol with a working `PortForwardingSession()`. No Rust equivalent exists — which is either a warning or an opportunity depending on your appetite.

### What the app actually runs

```
aws ssm start-session \
  --target i-0abc123def \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["mydb.abc123.us-east-1.rds.amazonaws.com"],
                 "portNumber":["5432"],
                 "localPortNumber":["0"]}'
```

Two documents, and the distinction matters:

- **`AWS-StartPortForwardingSession`** — params `portNumber`, `localPortNumber`. Forwards to a port **on the EC2 instance itself**. Use when the database runs on the bastion.
- **`AWS-StartPortForwardingSessionToRemoteHost`** — adds `host`. Forwards **through** the instance to another host. **This is the RDS case — the one in your screenshot.**

Note all parameter values are JSON *arrays of strings*. Getting this wrong produces an unhelpful error.

### Config UI

The app should ask for: AWS profile (parsed from `~/.aws/config`, SSO profiles included), region, target instance (offer a picker via `ssm:DescribeInstanceInformation` — much nicer than pasting instance IDs), remote host, remote port. Local port is always auto-assigned.

Detect `aws` and `session-manager-plugin` on PATH at startup. If missing, show install instructions rather than a cryptic spawn failure.

---

## 4. The tunnel supervisor — the actually valuable part

Everything above is table stakes. This section is the product.

### Why it's mandatory for SSM specifically

Three documented facts:

1. **Idle timeout: 20 minutes by default**, configurable 1–60 minutes at the account/region level.
2. **AWS does not document whether forwarded TCP traffic resets the idle timer.** The documented resets are keyboard input, terminal resize, and `ResumeSession`. Field reports are contradictory — [amazon-ssm-agent#450](https://github.com/aws/amazon-ssm-agent/issues/450) has users seeing port-forwarding sessions die in about a minute *with active connections*.
3. **The SSM service recycles the session WebSocket roughly every 60 minutes.** The plugin normally reconnects via `ResumeSession`, but there is a known race where the reconnect loses, the session is marked terminated, and it can never be resumed. Users report silent death at ~5h and ~19h.

Read that again: **an idle DB connection pool may not count as activity, and even a busy tunnel gets recycled hourly with a race condition attached.** There is no configuration that makes SSM tunnels reliable. The client has to handle it.

This also fully explains your screenshot. Nothing was misconfigured.

### Design

```rust
pub struct TunnelSupervisor {
    transport: Box<dyn Transport>,
    pool: Arc<ConnectionPool>,
    state: watch::Sender<TunnelState>,
    backoff: ExponentialBackoff,
}

pub enum TunnelState {
    Down,
    Connecting { attempt: u32 },
    Up { local_port: u16, since: Instant },
    Degraded { reason: String },   // up but health checks failing
    Failed { error: String, retry_in: Duration },
}
```

**Health check — probe the database, not the socket.** A TCP connect to a dead forwarder often still succeeds locally, because the listener is yours. The only honest check is a real round-trip on a real connection: `SELECT 1` on Postgres/MySQL, `PING` on Redis, `{ping: 1}` on Mongo. Every 30s, on a dedicated connection that isn't serving user queries. Anything else gives you false greens.

**Keepalive to defeat the idle timer.** Since forwarded traffic may not count, the `SELECT 1` health check doubles as the keepalive — it's real data over the tunnel on a real cadence. Make the interval configurable and default it well under the 20-minute idle timeout.

**On drop, in order:**

1. Mark state `Down`, **invalidate the entire pool immediately** — every pooled socket is now pointing at nothing. This is the step that's easy to forget and causes the "why is it hanging" experience.
2. Re-establish with exponential backoff: 1s, 2s, 4s, 8s, capped at 30s.
3. On success, allocate a new local port (assume the old one is gone), rebuild the pool, transition to `Up`.
4. Replay any query that was in flight **only if it was a read**. Never silently re-run a write — surface it and let the user decide.
5. Give up after N attempts and surface an actionable error.

**Proactive rotation.** Because the hourly recycle has a race, don't wait for it: tear down and re-establish SSM tunnels on your own schedule (say 45 minutes) during an idle moment. A planned 2-second reconnect at a quiet time beats an unplanned failure mid-query. Make it opt-out for people who'd rather not.

**Show it in the UI.** A small status dot per connection: green Up, amber Connecting/Degraded, red Failed, with uptime and last reconnect on hover. When a query fails because the tunnel is down, the error should say *"SSH tunnel to prod-bastion dropped 4s ago — reconnecting (attempt 2)"*, not *"connection refused."* The gap between those two messages is most of the perceived quality of the product.

**Reference-count tunnels.** Two connections to different databases on the same RDS instance should share one tunnel. Tear down when the last user disconnects, after a grace period.

---

## 5. Cloud-native auth

Tunnelling gets you to the port. Authentication is separate, and for managed databases it's increasingly token-based.

### AWS RDS IAM

Generate a SigV4 token (equivalent of `aws rds generate-db-auth-token`) and use it as the password. TLS required.

**The tunnel interaction is subtle and is the thing to get right:** the token is signed against the *real RDS endpoint*, not `localhost:15432`. So the connection profile needs both — the tunnel's local address for the socket, and the true RDS hostname for signing. DBeaver has a dedicated "RDS Endpoint" field for exactly this, which is worth copying outright.

Token lifetime is 15 minutes, **but it only affects the auth handshake** — established sessions are unaffected. So you regenerate per *new* connection, not per query. Relevant when the pool refills after a tunnel reconnect: that's a batch of new connections, all needing fresh tokens.

### Later

- **GCP Cloud SQL Auth Proxy** — same shape as SSM: a separate binary, ephemeral certs auto-refreshed hourly. Google ships in-process connectors for Go/Java/Python but **not Rust**, so shelling out is the path. Slots into `Transport` cleanly.
- **Azure Entra ID** — JWT as the password, 1h lifetime (24h for managed identities). No proxy equivalent exists; it's pure token auth, so it's a credential provider rather than a transport.

Model these as a `CredentialProvider` trait sitting beside `Transport`, so "how do I reach it" and "how do I prove who I am" stay separate. They compose independently — SSM tunnel + IAM token is a real and common combination.

---

## 6. MCP implications

From PLAN.md, the MCP server shares the core engine — so it inherits tunnels for free. Three things still need explicit handling:

- **Establish on demand.** If Claude calls `run_query` on a connection whose tunnel is down, the supervisor should bring it up and wait, not fail. Return a structured "establishing tunnel, retry" error if it exceeds the timeout, so the model retries rather than reporting failure to the user.
- **Never expose tunnel internals.** `list_connections` returns `prod-rds (postgres, via ssm)`. Not the instance ID, not the local port, not the AWS profile. Tunnel metadata is infrastructure detail the model has no use for and shouldn't be able to leak.
- **Interactive auth cannot happen over MCP.** If a tunnel needs a key passphrase or a 2FA code, there's nobody to type it. Return a clear error telling the model to ask the user to unlock it in the app. Pre-authorised connections (agent keys, cached IAM creds) work unattended; that's the intended path.

---

## 7. Roadmap fit

Insert between PLAN.md's Phase 2 and Phase 3:

**Phase 2.5 — Connectivity (1–2 weeks)**

1. `Transport` trait + `Direct` impl (refactor, no behaviour change)
2. `SshTunnel` via russh: agent auth first, then key/passphrase, then password, then keyboard-interactive
3. `TunnelSupervisor` with health checks, backoff, pool invalidation, UI status
4. `~/.ssh/config` import via `ssh2-config`, including `ProxyJump`
5. `Ssm` transport shelling out to `session-manager-plugin`, with proactive rotation
6. RDS IAM `CredentialProvider` with the separate signing-endpoint field

Build the supervisor at step 3, **before** SSM at step 5. If you add SSM first you'll be debugging tunnel drops without the machinery to observe or survive them — which is exactly the experience you're trying to fix.

---

## 8. What to demo

Open the app. Pick `prod-rds`. It reads your `~/.aws/config`, starts the SSM session itself, connects, and shows a green dot. Leave it an hour. Come back — still green, having quietly rotated the tunnel twice while you were at lunch. No terminal window. No `Exiting session with sessionId`. No reconnect dance.

Then ask Claude "what's the schema of the orders table?" and it just answers, through the same tunnel, without ever seeing an AWS credential.

That's a demo no other client can currently give.

---

## Sources

- [russh client Handle](https://docs.rs/russh/latest/russh/client/struct.Handle.html) · [russh keys/agent](https://docs.rs/russh/latest/russh/keys/agent/client/struct.AgentClient.html)
- [ssh2-config changelog](https://github.com/veeso/ssh2-config/blob/main/CHANGELOG.md) · [russh-config](https://crates.io/crates/russh-config)
- [SSM start-session documents](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-sessions-start.html) · [idle timeout](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-preferences-timeout.html) · [max duration](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-preferences-max-timeout.html)
- [session-manager-plugin source](https://github.com/aws/session-manager-plugin) · [ssm-session-client (Go reimpl)](https://github.com/mmmorris1975/ssm-session-client) · [WebSocket recycling report](https://repost.aws/questions/QUCtP6EpYARgCPY86nT0YMxw/ssm-port-forwarding-tunnel-silently-dies-after-hours-plugin-fails-to-reconnect-after-periodic-websocket-recycling) · [agent issue #450](https://github.com/aws/amazon-ssm-agent/issues/450)
- [DBeaver AWS SSM](https://dbeaver.com/docs/dbeaver/AWS-SSM-Configuration/) · [DBeaver AWS credentials](https://dbeaver.com/docs/dbeaver/AWS-Credentials/) · [TablePlus #3464](https://github.com/TablePlus/TablePlus/issues/3464)
- [RDS IAM auth](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.IAMDBAuth.html) · [Cloud SQL Auth Proxy](https://docs.cloud.google.com/sql/docs/postgres/sql-proxy) · [Azure Entra ID auth](https://learn.microsoft.com/azure/postgresql/flexible-server/concepts-azure-ad-authentication)

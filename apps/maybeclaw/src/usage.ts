export const GATEWAY_USAGE = `MaybeClaw — Agent Gateway

maybeclaw [--config <path>] [--port <number>] [--no-open]
maybeclaw serve [--config <path>] [--port <number>]
maybeclaw session create <name> --agent <id> [--agent <id>] [--allow-agent <id>]
    [--kind private|group --account <id> --conversation <id> --owner <user-id> --thread <id>]
maybeclaw session list|show|select|archive|restore|delete [id] [--confirm]
maybeclaw session rename <id> --name <name>
maybeclaw session admins <id> --identity <platform-user-key> [--identity <key>]
maybeclaw agent list|check|create|delete [id] [--session <id>] [--confirm]
maybeclaw agent save <id> --definition <json-file>
maybeclaw agent default|allow <id> [--agent <id>] --session <id>
maybeclaw task submit <prompt> --session <id> [--agent <id>] [--request-id <id>]
maybeclaw task list|status|result|cancel|run|recover [id]
maybeclaw channel status
maybeclaw delivery retry|retry-legacy <id> [--confirm] --server <url>
maybeclaw command <slash-command> [--session <id>]
maybeclaw migrate check|run

Common options: --config <path>, --data-directory <path> (default ~/.may/maybeclaw).
With no subcommand, start the Web console and open the default browser.
Missing configuration or administrator authentication opens local password setup.
With --no-open, open the initialization file printed by the service on this machine.
Use --no-open or serve to start only the service. Ctrl+C stops the service.
Use --server http://127.0.0.1:<port> to manage a running service. The client uses
MAYBECLAW_ADMIN_PASSWORD or --password-env. Local task submit waits for completion;
server submissions return once accepted. Serve continues work after clients leave.
Agent model, directory, and startup options belong in version: 2 Agent configuration.
Exit codes: 0 completed/accepted/query; 1 operation failed; 2 invalid command.
`;

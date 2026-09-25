# claude-mcp-view — read-only cluster identity for an MCP server

A ServiceAccount the workstation's Kubernetes MCP server authenticates as. The
server itself is provisioned outside this repo (the `mac-dev-playbook` repo);
this repo owns only the identity and what it may do.

Manifests: [infrastructure/configs/claude-mcp-view.yaml](../infrastructure/configs/claude-mcp-view.yaml),
reconciled by the `infra-configs` Kustomization.

## Two independent layers

1. **Server layer** — the MCP server runs with `--read-only`.
2. **Credential layer** — this ServiceAccount, which can only read.

Either layer alone should stop a write. The credential layer is the one that
matters if the server's own flag is ever wrong, bypassed or dropped in an
upgrade, so it must hold up on its own.

## What the ServiceAccount can do

- **`view`** (built-in ClusterRole), bound cluster-wide: get/list/watch on most
  namespaced resources. `view` excludes Secrets and RBAC objects by design.
- **`claude-mcp-view-nodes`**: get/list/watch on core `nodes`, and nothing
  else. `view` doesn't cover nodes (only `metrics.k8s.io` node metrics), and
  node health is one of the more useful things to read.

No write verb is granted anywhere. Check with:

```sh
kubectl auth can-i --list --as=system:serviceaccount:mcp:claude-mcp-view
```

## The token

`claude-mcp-view-token` is a `kubernetes.io/service-account-token` Secret
**stub**. The token controller fills in `token`, `ca.crt` and `namespace`
in-cluster. The manifest in Git carries no token material. The token doesn't
expire: that's deliberate, because nothing refreshes a desktop wrapper's
credential.

The workstation holds a single-context kubeconfig built from this Secret. It
must hold **only** this context. The MCP server has context-switching tools,
so an admin context in the same file would be an escalation path that never
has to defeat `--read-only`.

**Rotation / revocation:** delete the Secret. The token controller invalidates
it immediately, and Flux recreates the stub on the next `infra-configs`
reconcile, which mints a new token. Then rebuild the workstation kubeconfig.
This is the one delete this identity is designed for; it doesn't create drift,
because Flux puts back exactly what Git declares.

## Not in Git

- The kubeconfig on the workstation, and the token inside it.
- Network reachability of the API endpoint from off-LAN, which goes through
  the tailnet policy. A private record exists; it isn't described here.

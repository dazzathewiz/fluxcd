# The `.app` zone -- a second Traefik address

## What this is

Traefik serves two HTTPS entrypoints on two MetalLB addresses:

| Entrypoint  | Address       | Zone                       | Certificate               |
|-------------|---------------|----------------------------|---------------------------|
| `websecure` | `10.10.1.100` | `*.inf.${PERSONAL_DOMAIN}` | `inf-personal-domain-tls` |
| `appsecure` | `10.10.1.103` | `*.app.${PERSONAL_DOMAIN}` | `app-personal-domain-tls` |

Same Traefik pods, same middlewares, same chart. Only the listening port and the
published Service differ.

## Why, specifically

Every `.inf` route answers on one address. Anything permitted to reach that
address can reach every application behind it -- Traefik will route on whatever
`Host` header arrives, and each app's own login is the only thing in the way.
For most clients on this network that is fine, because they are trusted to the
same degree everywhere.

It stops being fine when a client is deliberately *less* trusted than the
network: a device that lives in a bag, leaves the house, and connects from
places nobody controls. Such a device can be restricted to a single address at
the network layer, but restricting it to `10.10.1.100` restricts it to nothing
useful -- that address is the front door to everything.

`appsecure` exists so that restriction means something. It carries only `.app`
routes, so a client confined to `10.10.1.103` cannot reach a `.inf` application
at all, with or without a forged `Host` header. That is a network-layer
boundary rather than an application-layer one, and it holds even if one of the
`.inf` applications has an authentication bypass.

## How it is wired

- The entrypoint is declared in the Traefik chart values
  ([infrastructure/controllers/traefik.yaml](../infrastructure/controllers/traefik.yaml))
  with `expose: false`, which creates the listener and the container port but
  keeps it off Traefik's own Service.
- It is published by a standalone Service
  ([infrastructure/controllers/traefik-app-service.yaml](../infrastructure/controllers/traefik-app-service.yaml))
  selecting the same pods. The pinned chart (`>=22.1.0 <24.0.0`) supports only
  one Service per release, which is why this is a hand-written object rather
  than a second entry in the chart's `service:` block.
- The certificate is a separate wildcard
  ([infrastructure/configs/certificates/app-personal-domain.yaml](../infrastructure/configs/certificates/app-personal-domain.yaml)).
  Separate zones, separate keys.
- An application joins the zone by setting `entryPoints: [appsecure]` and
  `tls.secretName: app-personal-domain-tls` on its IngressRoute. Nothing else
  changes.

## What is not in Git

- **DNS.** Each `*.app` hostname needs its own A record pointing at
  `10.10.1.103`, added by hand on **both** resolvers. There is no wildcard, for
  the same reason there is no `*.inf` wildcard: the zones do not map one-to-one
  onto a single address.
- **The overlay-network policy.** The access-control rules that decide which
  devices may reach which address live in the overlay network's policy file,
  not here. This repo builds the boundary; something else decides who is on
  which side of it. A private record covers the policy itself.

## Gotchas

- **`expose` changes shape on a chart major bump.** It is a boolean in chart 2x
  and a map in chart 26+ (`expose: {default: false}`). Revisit this block as
  part of any chart upgrade, not afterwards.
- **A wrong Service selector fails silently.** It produces a Service with no
  endpoints and an address that accepts connections and blackholes them. Verify
  against `kubectl -n traefik get svc traefik -o jsonpath='{.spec.selector}'`
  rather than assuming the chart's labels.
- **A missing namespace in the certificate's reflection annotation also fails
  silently.** Traefik falls back to its own default certificate and the page
  still loads. Check the served issuer, not whether the page renders.

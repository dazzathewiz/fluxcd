# 1Password Connect
Install the helm chart on the cluster using `1password-credentials.json`

## Where the secrets come from (not in this repo)
`op-credentials` and `onepassword-connect-token` are the root credentials for
every ExternalSecret in the cluster, and they are **not managed by Flux**. The
[k3s-ansible][k3s-ansible] provisioning repo creates them when it builds the
cluster:

- role `k3s_server_post`, task `op-credentials.yml`, gated by
  `install_onepassword_secret` (enabled in its prod inventory)
- templates `op-credentials.j2` and `op-token.j2`, applied with
  `kubectl apply` on every run of that role
- the credential and token values are passed to the playbook at run time;
  they aren't stored in either repo

After a cold rebuild, these Secrets exist only if that role has run. Until
then the Connect pod can't start, and no ExternalSecret syncs.

## Requirements
1. Obtain the `1password-credentials.json` file - see: [Secrets Automation Workflow][opautomation]
2. Copy the contents of `1password-credentials.json` to secret `op-credentials`, **as-is (raw JSON)**
    ```
    apiVersion: v1
    kind: Secret
    metadata:
        name: op-credentials
        namespace: 1password
        labels:
            security: generic
    type: Opaque
    stringData:
        1password-credentials.json: '<raw JSON contents of the file>'
    ```

    **Don't base64 encode the value before putting it in `stringData`.**
    Before connect chart 2.3.0 the chart passed this value to Connect as the
    `OP_SESSION` env var, which needed it base64 encoded first, so the Secret
    held it double base64 encoded (see: [illegal base64 data at input byte 0][base64encode]).
    From 2.3.0 the chart mounts the value as a file and points `OP_SESSION` at
    the path, so Connect reads it as JSON. A double-encoded Secret makes the
    new Connect pod fail, while the old pod keeps serving, so the HelmRelease
    upgrade times out and `infra-controllers` stops being Ready.

    Quick check: decode the Secret's value once and it should start with `{`.
    Starting with `ey` means it's still double encoded. To convert an existing
    double-encoded Secret in place, without writing the JSON to disk:
    ```
    kubectl -n 1password get secret op-credentials -o json \
      | jq '.data["1password-credentials.json"] |= @base64d | del(.metadata.annotations, .metadata.resourceVersion, .metadata.uid, .metadata.creationTimestamp, .metadata.managedFields)' \
      | kubectl replace -f -
    ```

    > **k3s-ansible must match.** Its `op-credentials.j2` template must produce
    > the raw JSON. If it still base64 encodes the value, any re-run of
    > `k3s_server_post` puts the old format back, and Connect breaks the next
    > time its pod restarts.

3. Copy the Access Token setup by 1Password to secret `onepassword-connect-token`
    ```
    apiVersion: v1
    kind: Secret
    metadata:
        name: onepassword-connect-token
        namespace: 1password
        labels:
            security: generic
    type: Opaque
    stringData:
        token: xxx
    ```

4. (Optional) Setup a secretStore:
    - Requires `external-secrets` helm chart installed
    - `connectHost` can refer to the kubernetes service URL: service-name.namespace.svc.cluster.local:service-port
    - `8080` is the connect-api container endpoint tcp default
    - Note the scoping difference between [secretstore][SecretStore] and [ClusterSecretStore][clustersecretstore]
    - See: [1Password Secrets Automation][1password-externalsecrets]
    SecretStore:
    ```
    apiVersion: external-secrets.io/v1
    kind: SecretStore
    metadata:
        name: onepassword-k3s
        namespace: 1password
    spec:
    provider:
        onepassword:
        connectHost: http://onepassword-connect.1password.svc.cluster.local:8080
        vaults:
            k3s: 1  # search order
        auth:
            secretRef:
            connectTokenSecretRef:
                name: onepassword-connect-token
                key: token
    ```
    ClusterSecretStore:
    ```
    apiVersion: external-secrets.io/v1
    kind: ClusterSecretStore
    metadata:
        name: onepassword-k3s
    spec:
        provider:
            onepassword:
            connectHost: http://onepassword-connect.1password.svc.cluster.local:8080
            vaults:
                k3s: 1  # search order
            auth:
                secretRef:
                connectTokenSecretRef:
                    name: onepassword-connect-token
                    key: token
                    namespace: 1password
    ```

## Other Notes
1Password is included in FluxCD Secrets Management recommendations, particularly [Secrets Synchronized by Operators][flux-secrets-operators]

This uses ExternalSecrets instead of the 1password operator simply because of comments that [ExternalSecrets as their onepassword integration is better than 1password's integration][op-operator-comment]

[k3s-ansible]: https://github.com/dazzathewiz/k3s-ansible
[opdeploy]: https://github.com/1Password/connect-helm-charts/tree/main/charts/connect
[opautomation]: https://developer.1password.com/docs/connect/get-started/
[base64encode]: https://1password.community/discussion/131378/loadlocalauthv2-failed-to-credentialsdatafrombase64
[1password-externalsecrets]: https://external-secrets.io/v0.5.7/provider-1password-automation/#creating-compatible-1password-items
[op-operator-comment]: https://github.com/1Password/onepassword-operator/issues/128
[flux-secrets-operators]: https://fluxcd.io/flux/security/secrets-management/#secrets-synchronized-by-operators
[clustersecretstore]: https://external-secrets.io/v0.4.4/api-clustersecretstore/
[secretstore]: https://external-secrets.io/v0.4.4/api-secretstore/

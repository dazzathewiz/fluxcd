# 1Password Connect
Install the helm chart on the cluster using `1password-credentials.json`

## Requirements
1. Obtain the `1password-credentials.json` file - see: [Secrets Automation Workflow][opautomation]
2. Copy the contents of `1password-credentials.json` to secret `op-credential`
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
        1password-credentials.json: 'xxx'
    ```

    The contents of `stringData` needs to be base64 encoded before being setup in kubernetes - see: [illegal base64 data at input byte 0][base64encode]
    This means it's double base64 encoded.

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
    apiVersion: external-secrets.io/v1beta1
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
    apiVersion: external-secrets.io/v1beta1
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

[opdeploy]: https://github.com/1Password/connect-helm-charts/tree/main/charts/connect
[opautomation]: https://developer.1password.com/docs/connect/get-started/
[base64encode]: https://1password.community/discussion/131378/loadlocalauthv2-failed-to-credentialsdatafrombase64
[1password-externalsecrets]: https://external-secrets.io/v0.5.7/provider-1password-automation/#creating-compatible-1password-items
[op-operator-comment]: https://github.com/1Password/onepassword-operator/issues/128
[flux-secrets-operators]: https://fluxcd.io/flux/security/secrets-management/#secrets-synchronized-by-operators
[clustersecretstore]: https://external-secrets.io/v0.4.4/api-clustersecretstore/
[secretstore]: https://external-secrets.io/v0.4.4/api-secretstore/

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

[opdeploy]: https://github.com/1Password/connect-helm-charts/tree/main/charts/connect
[opautomation]: https://developer.1password.com/docs/connect/get-started/
[base64encode]: https://1password.community/discussion/131378/loadlocalauthv2-failed-to-credentialsdatafrombase64

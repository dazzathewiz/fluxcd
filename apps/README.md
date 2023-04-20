# Applications

## Plex

- Resource scheduleing the GPU

    ### GPU Resource passthrough

    Find the GPU resources available on worker nodes by:
    - Running `lspci -nn` or `lspci -vmm` and look for `VGA compatible controller` in the output
    - Correlating the PCI ID's to [online ID list](https://pci-ids.ucw.cz/v2.2/pci.ids)

    ### GPU Preferred Scheduling
    Desired state is that when the plex container is scheduled, it picks the node with the best GPU available. To achieve this, we need to understand 
    PCI device `class`, `vendor`, and `device`. The node-feature-discovery in the cluster is configured to include this in a node label:
    | Node Label | Class | Vendor | Device |
    | --- | --- | --- | --- |
    | `feature.node.kubernetes.io/pci-0300_8086_4c8a.present=true` | `0300` -> "VGA compatible controller" | `8086` -> "Intel Corporation" | `3e92` -> "RocketLake-S GT1 [UHD Graphics 750]" |
    | `feature.node.kubernetes.io/pci-0300_8086_3e92.present=true` | `0300` -> "VGA compatible controller" | `8086` -> "Intel Corporation" | `3e92` -> "UHD Graphics 630 (Desktop)" |
    | `feature.node.kubernetes.io/pci-0300_8086_1912.present=true` | `0300` -> "VGA compatible controller" | `8086` -> "Intel Corporation" | `1912` -> "HD Graphics 530" |

    ### Other Reading
    [Clusters containing different types of GPU's](https://kubernetes.io/docs/tasks/manage-gpus/scheduling-gpus/)
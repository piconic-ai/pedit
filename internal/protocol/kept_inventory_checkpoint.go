package protocol

import (
	"bytes"
	"errors"
)

// A distinct domain and version select inventory-mode replay inside the host-signed checkpoint.
const inventoryCheckpointDomain = "pedit/v6/inventory-checkpoint\x00"

var errInventoryCheckpoint = errors.New("invalid inventory checkpoint")

// EncodeKeptInventoryCheckpoint produces plaintext for SealKeptCheckpoint. The
// caller is responsible for capturing a complete, consistent inventory.
func EncodeKeptInventoryCheckpoint(payload KeptMultiPayload) ([]byte, error) {
	if len(payload.Manifest) != 2 {
		return nil, errInventoryCheckpoint
	}
	raw, err := EncodeKeptMultiPayload(payload)
	if err != nil || len(raw) > maxKeptCheckpointPayload-len(inventoryCheckpointDomain)-1 {
		return nil, errInventoryCheckpoint
	}
	out := append([]byte(inventoryCheckpointDomain), 0)
	return append(out, raw...), nil
}

func decodeKeptInventoryCheckpoint(raw []byte) (KeptMultiPayload, error) {
	if len(raw) < len(inventoryCheckpointDomain)+1 || !bytes.Equal(raw[:len(inventoryCheckpointDomain)], []byte(inventoryCheckpointDomain)) || raw[len(inventoryCheckpointDomain)] != 0 {
		return KeptMultiPayload{}, errInventoryCheckpoint
	}
	payload, err := DecodeKeptMultiPayload(raw[len(inventoryCheckpointDomain)+1:], MaxKeptCheckpointReceipts)
	if err != nil || len(payload.Manifest) != 2 {
		return KeptMultiPayload{}, errInventoryCheckpoint
	}
	canonical, err := EncodeKeptInventoryCheckpoint(payload)
	if err != nil || !bytes.Equal(raw, canonical) {
		return KeptMultiPayload{}, errInventoryCheckpoint
	}
	return payload, nil
}

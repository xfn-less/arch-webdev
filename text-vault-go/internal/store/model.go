package store

import (
	"encoding/json"
	"errors"
)

var (
	ErrConflict = errors.New("store conflict")
	ErrNotFound = errors.New("store value not found")
)

type CipherObject struct {
	ID       string          `json:"id"`
	Kind     string          `json:"kind"`
	Revision uint64          `json:"revision"`
	Envelope json.RawMessage `json:"envelope"`
}

type ObjectRef struct {
	Kind     string `json:"kind"`
	Revision uint64 `json:"revision"`
}

type Manifest struct {
	SchemaVersion int                  `json:"schemaVersion"`
	Generation    uint64               `json:"generation"`
	Objects       map[string]ObjectRef `json:"objects"`
}

type Snapshot struct {
	Manifest Manifest                `json:"manifest"`
	Objects  map[string]CipherObject `json:"objects"`
}

type Changes struct {
	Generation uint64                  `json:"generation"`
	Objects    map[string]CipherObject `json:"objects"`
}

type CommitRequest struct {
	BaseGeneration uint64         `json:"baseGeneration"`
	Objects        []CipherObject `json:"objects"`
}

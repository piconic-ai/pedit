package hoststate

type RecoveryOutputKind uint8

const (
	RecoveryText RecoveryOutputKind = iota + 1
	RecoveryComments
)

func recoveryOutputSuffix(kind RecoveryOutputKind) (string, bool) {
	switch kind {
	case RecoveryText:
		return ".recovery.txt", true
	case RecoveryComments:
		return ".recovery-comments.json", true
	default:
		return "", false
	}
}

// Code generated from src/contracts/state-domains.json; DO NOT EDIT.
package contracts

import (
	"encoding/json"
	"errors"
)

type AppUpdateStatus string

const (
	AppUpdateStatusIdle      AppUpdateStatus = "idle"
	AppUpdateStatusChecking  AppUpdateStatus = "checking"
	AppUpdateStatusAvailable AppUpdateStatus = "available"
	AppUpdateStatusCurrent   AppUpdateStatus = "current"
	AppUpdateStatusFailed    AppUpdateStatus = "failed"
)

func (value AppUpdateStatus) Valid() bool {
	switch value {
	case AppUpdateStatusIdle, AppUpdateStatusChecking, AppUpdateStatusAvailable, AppUpdateStatusCurrent, AppUpdateStatusFailed:
		return true
	default:
		return false
	}
}
func (value *AppUpdateStatus) UnmarshalJSON(data []byte) error {
	var wire string
	if err := json.Unmarshal(data, &wire); err != nil || !AppUpdateStatus(wire).Valid() {
		return errors.New("invalid AppUpdateStatus")
	}
	*value = AppUpdateStatus(wire)
	return nil
}
func (value AppUpdateStatus) MarshalJSON() ([]byte, error) {
	if !value.Valid() {
		return nil, errors.New("invalid AppUpdateStatus")
	}
	return json.Marshal(string(value))
}

type BackupMode string

const (
	BackupModeManual    BackupMode = "manual"
	BackupModeAutomatic BackupMode = "automatic"
)

func (value BackupMode) Valid() bool {
	switch value {
	case BackupModeManual, BackupModeAutomatic:
		return true
	default:
		return false
	}
}
func (value *BackupMode) UnmarshalJSON(data []byte) error {
	var wire string
	if err := json.Unmarshal(data, &wire); err != nil || !BackupMode(wire).Valid() {
		return errors.New("invalid BackupMode")
	}
	*value = BackupMode(wire)
	return nil
}
func (value BackupMode) MarshalJSON() ([]byte, error) {
	if !value.Valid() {
		return nil, errors.New("invalid BackupMode")
	}
	return json.Marshal(string(value))
}

type BackupPhase string

const (
	BackupPhaseIdle      BackupPhase = "idle"
	BackupPhaseBackingUp BackupPhase = "backing-up"
	BackupPhaseRestoring BackupPhase = "restoring"
	BackupPhaseFailed    BackupPhase = "failed"
	BackupPhaseUnknown   BackupPhase = "unknown"
)

func (value BackupPhase) Valid() bool {
	switch value {
	case BackupPhaseIdle, BackupPhaseBackingUp, BackupPhaseRestoring, BackupPhaseFailed, BackupPhaseUnknown:
		return true
	default:
		return false
	}
}
func (value *BackupPhase) UnmarshalJSON(data []byte) error {
	var wire string
	if err := json.Unmarshal(data, &wire); err != nil || !BackupPhase(wire).Valid() {
		return errors.New("invalid BackupPhase")
	}
	*value = BackupPhase(wire)
	return nil
}
func (value BackupPhase) MarshalJSON() ([]byte, error) {
	if !value.Valid() {
		return nil, errors.New("invalid BackupPhase")
	}
	return json.Marshal(string(value))
}

type ChatTaskStatus string

const (
	ChatTaskStatusDraft       ChatTaskStatus = "draft"
	ChatTaskStatusAccepted    ChatTaskStatus = "accepted"
	ChatTaskStatusQueued      ChatTaskStatus = "queued"
	ChatTaskStatusRunning     ChatTaskStatus = "running"
	ChatTaskStatusWaitingUser ChatTaskStatus = "waiting_user"
	ChatTaskStatusPausing     ChatTaskStatus = "pausing"
	ChatTaskStatusPaused      ChatTaskStatus = "paused"
	ChatTaskStatusFailed      ChatTaskStatus = "failed"
	ChatTaskStatusReview      ChatTaskStatus = "review"
	ChatTaskStatusCompleted   ChatTaskStatus = "completed"
	ChatTaskStatusCancelled   ChatTaskStatus = "cancelled"
)

func (value ChatTaskStatus) Valid() bool {
	switch value {
	case ChatTaskStatusDraft, ChatTaskStatusAccepted, ChatTaskStatusQueued, ChatTaskStatusRunning, ChatTaskStatusWaitingUser, ChatTaskStatusPausing, ChatTaskStatusPaused, ChatTaskStatusFailed, ChatTaskStatusReview, ChatTaskStatusCompleted, ChatTaskStatusCancelled:
		return true
	default:
		return false
	}
}
func (value *ChatTaskStatus) UnmarshalJSON(data []byte) error {
	var wire string
	if err := json.Unmarshal(data, &wire); err != nil || !ChatTaskStatus(wire).Valid() {
		return errors.New("invalid ChatTaskStatus")
	}
	*value = ChatTaskStatus(wire)
	return nil
}
func (value ChatTaskStatus) MarshalJSON() ([]byte, error) {
	if !value.Valid() {
		return nil, errors.New("invalid ChatTaskStatus")
	}
	return json.Marshal(string(value))
}

type ComputerControlStatus string

const (
	ComputerControlStatusDant       ComputerControlStatus = "dant"
	ComputerControlStatusAcquiring  ComputerControlStatus = "acquiring"
	ComputerControlStatusTakingOver ComputerControlStatus = "taking-over"
	ComputerControlStatusHuman      ComputerControlStatus = "human"
)

func (value ComputerControlStatus) Valid() bool {
	switch value {
	case ComputerControlStatusDant, ComputerControlStatusAcquiring, ComputerControlStatusTakingOver, ComputerControlStatusHuman:
		return true
	default:
		return false
	}
}
func (value *ComputerControlStatus) UnmarshalJSON(data []byte) error {
	var wire string
	if err := json.Unmarshal(data, &wire); err != nil || !ComputerControlStatus(wire).Valid() {
		return errors.New("invalid ComputerControlStatus")
	}
	*value = ComputerControlStatus(wire)
	return nil
}
func (value ComputerControlStatus) MarshalJSON() ([]byte, error) {
	if !value.Valid() {
		return nil, errors.New("invalid ComputerControlStatus")
	}
	return json.Marshal(string(value))
}

type ConnectionStatus string

const (
	ConnectionStatusOffline    ConnectionStatus = "offline"
	ConnectionStatusConnecting ConnectionStatus = "connecting"
	ConnectionStatusOnline     ConnectionStatus = "online"
)

func (value ConnectionStatus) Valid() bool {
	switch value {
	case ConnectionStatusOffline, ConnectionStatusConnecting, ConnectionStatusOnline:
		return true
	default:
		return false
	}
}
func (value *ConnectionStatus) UnmarshalJSON(data []byte) error {
	var wire string
	if err := json.Unmarshal(data, &wire); err != nil || !ConnectionStatus(wire).Valid() {
		return errors.New("invalid ConnectionStatus")
	}
	*value = ConnectionStatus(wire)
	return nil
}
func (value ConnectionStatus) MarshalJSON() ([]byte, error) {
	if !value.Valid() {
		return nil, errors.New("invalid ConnectionStatus")
	}
	return json.Marshal(string(value))
}

type ContinuationDispatchPhase string

const (
	ContinuationDispatchPhaseClaimed      ContinuationDispatchPhase = "claimed"
	ContinuationDispatchPhaseSubmitting   ContinuationDispatchPhase = "submitting"
	ContinuationDispatchPhaseAcknowledged ContinuationDispatchPhase = "acknowledged"
	ContinuationDispatchPhaseUnknown      ContinuationDispatchPhase = "unknown"
)

func (value ContinuationDispatchPhase) Valid() bool {
	switch value {
	case ContinuationDispatchPhaseClaimed, ContinuationDispatchPhaseSubmitting, ContinuationDispatchPhaseAcknowledged, ContinuationDispatchPhaseUnknown:
		return true
	default:
		return false
	}
}
func (value *ContinuationDispatchPhase) UnmarshalJSON(data []byte) error {
	var wire string
	if err := json.Unmarshal(data, &wire); err != nil || !ContinuationDispatchPhase(wire).Valid() {
		return errors.New("invalid ContinuationDispatchPhase")
	}
	*value = ContinuationDispatchPhase(wire)
	return nil
}
func (value ContinuationDispatchPhase) MarshalJSON() ([]byte, error) {
	if !value.Valid() {
		return nil, errors.New("invalid ContinuationDispatchPhase")
	}
	return json.Marshal(string(value))
}

type DesktopPhase string

const (
	DesktopPhaseIdle       DesktopPhase = "idle"
	DesktopPhasePausing    DesktopPhase = "pausing"
	DesktopPhasePaused     DesktopPhase = "paused"
	DesktopPhaseSuspending DesktopPhase = "suspending"
	DesktopPhaseSuspended  DesktopPhase = "suspended"
	DesktopPhaseResuming   DesktopPhase = "resuming"
)

func (value DesktopPhase) Valid() bool {
	switch value {
	case DesktopPhaseIdle, DesktopPhasePausing, DesktopPhasePaused, DesktopPhaseSuspending, DesktopPhaseSuspended, DesktopPhaseResuming:
		return true
	default:
		return false
	}
}
func (value *DesktopPhase) UnmarshalJSON(data []byte) error {
	var wire string
	if err := json.Unmarshal(data, &wire); err != nil || !DesktopPhase(wire).Valid() {
		return errors.New("invalid DesktopPhase")
	}
	*value = DesktopPhase(wire)
	return nil
}
func (value DesktopPhase) MarshalJSON() ([]byte, error) {
	if !value.Valid() {
		return nil, errors.New("invalid DesktopPhase")
	}
	return json.Marshal(string(value))
}

type HostPlatformId string

const (
	HostPlatformIdWindows     HostPlatformId = "win32"
	HostPlatformIdMacOS       HostPlatformId = "darwin"
	HostPlatformIdLinux       HostPlatformId = "linux"
	HostPlatformIdUnsupported HostPlatformId = "unsupported"
)

func (value HostPlatformId) Valid() bool {
	switch value {
	case HostPlatformIdWindows, HostPlatformIdMacOS, HostPlatformIdLinux, HostPlatformIdUnsupported:
		return true
	default:
		return false
	}
}
func (value *HostPlatformId) UnmarshalJSON(data []byte) error {
	var wire string
	if err := json.Unmarshal(data, &wire); err != nil || !HostPlatformId(wire).Valid() {
		return errors.New("invalid HostPlatformId")
	}
	*value = HostPlatformId(wire)
	return nil
}
func (value HostPlatformId) MarshalJSON() ([]byte, error) {
	if !value.Valid() {
		return nil, errors.New("invalid HostPlatformId")
	}
	return json.Marshal(string(value))
}

type MemoryEntryStatus string

const (
	MemoryEntryStatusCandidate  MemoryEntryStatus = "candidate"
	MemoryEntryStatusConfirmed  MemoryEntryStatus = "confirmed"
	MemoryEntryStatusConflicted MemoryEntryStatus = "conflicted"
	MemoryEntryStatusRejected   MemoryEntryStatus = "rejected"
)

func (value MemoryEntryStatus) Valid() bool {
	switch value {
	case MemoryEntryStatusCandidate, MemoryEntryStatusConfirmed, MemoryEntryStatusConflicted, MemoryEntryStatusRejected:
		return true
	default:
		return false
	}
}
func (value *MemoryEntryStatus) UnmarshalJSON(data []byte) error {
	var wire string
	if err := json.Unmarshal(data, &wire); err != nil || !MemoryEntryStatus(wire).Valid() {
		return errors.New("invalid MemoryEntryStatus")
	}
	*value = MemoryEntryStatus(wire)
	return nil
}
func (value MemoryEntryStatus) MarshalJSON() ([]byte, error) {
	if !value.Valid() {
		return nil, errors.New("invalid MemoryEntryStatus")
	}
	return json.Marshal(string(value))
}

type PlanStepStatus string

const (
	PlanStepStatusPending    PlanStepStatus = "pending"
	PlanStepStatusInProgress PlanStepStatus = "inProgress"
	PlanStepStatusCompleted  PlanStepStatus = "completed"
)

func (value PlanStepStatus) Valid() bool {
	switch value {
	case PlanStepStatusPending, PlanStepStatusInProgress, PlanStepStatusCompleted:
		return true
	default:
		return false
	}
}
func (value *PlanStepStatus) UnmarshalJSON(data []byte) error {
	var wire string
	if err := json.Unmarshal(data, &wire); err != nil || !PlanStepStatus(wire).Valid() {
		return errors.New("invalid PlanStepStatus")
	}
	*value = PlanStepStatus(wire)
	return nil
}
func (value PlanStepStatus) MarshalJSON() ([]byte, error) {
	if !value.Valid() {
		return nil, errors.New("invalid PlanStepStatus")
	}
	return json.Marshal(string(value))
}

type ProvisioningStatus string

const (
	ProvisioningStatusIdle          ProvisioningStatus = "idle"
	ProvisioningStatusPreparing     ProvisioningStatus = "preparing"
	ProvisioningStatusAwaitingAdmin ProvisioningStatus = "awaiting-admin"
	ProvisioningStatusCreating      ProvisioningStatus = "creating"
	ProvisioningStatusInstalling    ProvisioningStatus = "installing"
	ProvisioningStatusReady         ProvisioningStatus = "ready"
	ProvisioningStatusFailed        ProvisioningStatus = "failed"
)

func (value ProvisioningStatus) Valid() bool {
	switch value {
	case ProvisioningStatusIdle, ProvisioningStatusPreparing, ProvisioningStatusAwaitingAdmin, ProvisioningStatusCreating, ProvisioningStatusInstalling, ProvisioningStatusReady, ProvisioningStatusFailed:
		return true
	default:
		return false
	}
}
func (value *ProvisioningStatus) UnmarshalJSON(data []byte) error {
	var wire string
	if err := json.Unmarshal(data, &wire); err != nil || !ProvisioningStatus(wire).Valid() {
		return errors.New("invalid ProvisioningStatus")
	}
	*value = ProvisioningStatus(wire)
	return nil
}
func (value ProvisioningStatus) MarshalJSON() ([]byte, error) {
	if !value.Valid() {
		return nil, errors.New("invalid ProvisioningStatus")
	}
	return json.Marshal(string(value))
}

type RecordingDraftStatus string

const (
	RecordingDraftStatusRecording RecordingDraftStatus = "recording"
	RecordingDraftStatusPaused    RecordingDraftStatus = "paused"
	RecordingDraftStatusReady     RecordingDraftStatus = "ready"
	RecordingDraftStatusFinishing RecordingDraftStatus = "finishing"
)

func (value RecordingDraftStatus) Valid() bool {
	switch value {
	case RecordingDraftStatusRecording, RecordingDraftStatusPaused, RecordingDraftStatusReady, RecordingDraftStatusFinishing:
		return true
	default:
		return false
	}
}
func (value *RecordingDraftStatus) UnmarshalJSON(data []byte) error {
	var wire string
	if err := json.Unmarshal(data, &wire); err != nil || !RecordingDraftStatus(wire).Valid() {
		return errors.New("invalid RecordingDraftStatus")
	}
	*value = RecordingDraftStatus(wire)
	return nil
}
func (value RecordingDraftStatus) MarshalJSON() ([]byte, error) {
	if !value.Valid() {
		return nil, errors.New("invalid RecordingDraftStatus")
	}
	return json.Marshal(string(value))
}

type ScheduleDispatchPhase string

const (
	ScheduleDispatchPhasePrepared     ScheduleDispatchPhase = "prepared"
	ScheduleDispatchPhaseMaterialized ScheduleDispatchPhase = "materialized"
	ScheduleDispatchPhaseHeld         ScheduleDispatchPhase = "held"
	ScheduleDispatchPhaseHandedOff    ScheduleDispatchPhase = "handed-off"
)

func (value ScheduleDispatchPhase) Valid() bool {
	switch value {
	case ScheduleDispatchPhasePrepared, ScheduleDispatchPhaseMaterialized, ScheduleDispatchPhaseHeld, ScheduleDispatchPhaseHandedOff:
		return true
	default:
		return false
	}
}
func (value *ScheduleDispatchPhase) UnmarshalJSON(data []byte) error {
	var wire string
	if err := json.Unmarshal(data, &wire); err != nil || !ScheduleDispatchPhase(wire).Valid() {
		return errors.New("invalid ScheduleDispatchPhase")
	}
	*value = ScheduleDispatchPhase(wire)
	return nil
}
func (value ScheduleDispatchPhase) MarshalJSON() ([]byte, error) {
	if !value.Valid() {
		return nil, errors.New("invalid ScheduleDispatchPhase")
	}
	return json.Marshal(string(value))
}

type ScheduleStatus string

const (
	ScheduleStatusPending    ScheduleStatus = "pending"
	ScheduleStatusPaused     ScheduleStatus = "paused"
	ScheduleStatusDispatched ScheduleStatus = "dispatched"
)

func (value ScheduleStatus) Valid() bool {
	switch value {
	case ScheduleStatusPending, ScheduleStatusPaused, ScheduleStatusDispatched:
		return true
	default:
		return false
	}
}
func (value *ScheduleStatus) UnmarshalJSON(data []byte) error {
	var wire string
	if err := json.Unmarshal(data, &wire); err != nil || !ScheduleStatus(wire).Valid() {
		return errors.New("invalid ScheduleStatus")
	}
	*value = ScheduleStatus(wire)
	return nil
}
func (value ScheduleStatus) MarshalJSON() ([]byte, error) {
	if !value.Valid() {
		return nil, errors.New("invalid ScheduleStatus")
	}
	return json.Marshal(string(value))
}

type ServiceUpdateStatus string

const (
	ServiceUpdateStatusChecking ServiceUpdateStatus = "checking"
	ServiceUpdateStatusUpdating ServiceUpdateStatus = "updating"
	ServiceUpdateStatusPending  ServiceUpdateStatus = "pending"
	ServiceUpdateStatusCurrent  ServiceUpdateStatus = "current"
	ServiceUpdateStatusFailed   ServiceUpdateStatus = "failed"
)

func (value ServiceUpdateStatus) Valid() bool {
	switch value {
	case ServiceUpdateStatusChecking, ServiceUpdateStatusUpdating, ServiceUpdateStatusPending, ServiceUpdateStatusCurrent, ServiceUpdateStatusFailed:
		return true
	default:
		return false
	}
}
func (value *ServiceUpdateStatus) UnmarshalJSON(data []byte) error {
	var wire string
	if err := json.Unmarshal(data, &wire); err != nil || !ServiceUpdateStatus(wire).Valid() {
		return errors.New("invalid ServiceUpdateStatus")
	}
	*value = ServiceUpdateStatus(wire)
	return nil
}
func (value ServiceUpdateStatus) MarshalJSON() ([]byte, error) {
	if !value.Valid() {
		return nil, errors.New("invalid ServiceUpdateStatus")
	}
	return json.Marshal(string(value))
}

type SubmissionStatus string

const (
	SubmissionStatusPreparing    SubmissionStatus = "preparing"
	SubmissionStatusSubmitting   SubmissionStatus = "submitting"
	SubmissionStatusConfirmed    SubmissionStatus = "confirmed"
	SubmissionStatusUnknown      SubmissionStatus = "unknown"
	SubmissionStatusNotSubmitted SubmissionStatus = "not-submitted"
)

func (value SubmissionStatus) Valid() bool {
	switch value {
	case SubmissionStatusPreparing, SubmissionStatusSubmitting, SubmissionStatusConfirmed, SubmissionStatusUnknown, SubmissionStatusNotSubmitted:
		return true
	default:
		return false
	}
}
func (value *SubmissionStatus) UnmarshalJSON(data []byte) error {
	var wire string
	if err := json.Unmarshal(data, &wire); err != nil || !SubmissionStatus(wire).Valid() {
		return errors.New("invalid SubmissionStatus")
	}
	*value = SubmissionStatus(wire)
	return nil
}
func (value SubmissionStatus) MarshalJSON() ([]byte, error) {
	if !value.Valid() {
		return nil, errors.New("invalid SubmissionStatus")
	}
	return json.Marshal(string(value))
}

type TaskPriority string

const (
	TaskPriorityHigh   TaskPriority = "high"
	TaskPriorityNormal TaskPriority = "normal"
	TaskPriorityLow    TaskPriority = "low"
)

func (value TaskPriority) Valid() bool {
	switch value {
	case TaskPriorityHigh, TaskPriorityNormal, TaskPriorityLow:
		return true
	default:
		return false
	}
}
func (value *TaskPriority) UnmarshalJSON(data []byte) error {
	var wire string
	if err := json.Unmarshal(data, &wire); err != nil || !TaskPriority(wire).Valid() {
		return errors.New("invalid TaskPriority")
	}
	*value = TaskPriority(wire)
	return nil
}
func (value TaskPriority) MarshalJSON() ([]byte, error) {
	if !value.Valid() {
		return nil, errors.New("invalid TaskPriority")
	}
	return json.Marshal(string(value))
}

type TaskProgressStage string

const (
	TaskProgressStagePreparing  TaskProgressStage = "preparing"
	TaskProgressStageWorking    TaskProgressStage = "working"
	TaskProgressStageComputer   TaskProgressStage = "computer"
	TaskProgressStageCommand    TaskProgressStage = "command"
	TaskProgressStageFiles      TaskProgressStage = "files"
	TaskProgressStageResponding TaskProgressStage = "responding"
	TaskProgressStageSaving     TaskProgressStage = "saving"
)

func (value TaskProgressStage) Valid() bool {
	switch value {
	case TaskProgressStagePreparing, TaskProgressStageWorking, TaskProgressStageComputer, TaskProgressStageCommand, TaskProgressStageFiles, TaskProgressStageResponding, TaskProgressStageSaving:
		return true
	default:
		return false
	}
}
func (value *TaskProgressStage) UnmarshalJSON(data []byte) error {
	var wire string
	if err := json.Unmarshal(data, &wire); err != nil || !TaskProgressStage(wire).Valid() {
		return errors.New("invalid TaskProgressStage")
	}
	*value = TaskProgressStage(wire)
	return nil
}
func (value TaskProgressStage) MarshalJSON() ([]byte, error) {
	if !value.Valid() {
		return nil, errors.New("invalid TaskProgressStage")
	}
	return json.Marshal(string(value))
}

type TaskStatus string

const (
	TaskStatusDraft       TaskStatus = "draft"
	TaskStatusAccepted    TaskStatus = "accepted"
	TaskStatusQueued      TaskStatus = "queued"
	TaskStatusRunning     TaskStatus = "running"
	TaskStatusContinuing  TaskStatus = "continuing"
	TaskStatusWaitingUser TaskStatus = "waiting_user"
	TaskStatusPausing     TaskStatus = "pausing"
	TaskStatusPaused      TaskStatus = "paused"
	TaskStatusUnknown     TaskStatus = "unknown"
	TaskStatusReview      TaskStatus = "review"
	TaskStatusFailed      TaskStatus = "failed"
	TaskStatusCompleted   TaskStatus = "completed"
	TaskStatusCancelled   TaskStatus = "cancelled"
	TaskStatusInterrupted TaskStatus = "interrupted"
)

func (value TaskStatus) Valid() bool {
	switch value {
	case TaskStatusDraft, TaskStatusAccepted, TaskStatusQueued, TaskStatusRunning, TaskStatusContinuing, TaskStatusWaitingUser, TaskStatusPausing, TaskStatusPaused, TaskStatusUnknown, TaskStatusReview, TaskStatusFailed, TaskStatusCompleted, TaskStatusCancelled, TaskStatusInterrupted:
		return true
	default:
		return false
	}
}
func (value *TaskStatus) UnmarshalJSON(data []byte) error {
	var wire string
	if err := json.Unmarshal(data, &wire); err != nil || !TaskStatus(wire).Valid() {
		return errors.New("invalid TaskStatus")
	}
	*value = TaskStatus(wire)
	return nil
}
func (value TaskStatus) MarshalJSON() ([]byte, error) {
	if !value.Valid() {
		return nil, errors.New("invalid TaskStatus")
	}
	return json.Marshal(string(value))
}

type UpdateDownloadStatus string

const (
	UpdateDownloadStatusDownloading    UpdateDownloadStatus = "downloading"
	UpdateDownloadStatusReady          UpdateDownloadStatus = "ready"
	UpdateDownloadStatusInstalling     UpdateDownloadStatus = "installing"
	UpdateDownloadStatusDownloadFailed UpdateDownloadStatus = "downloadFailed"
)

func (value UpdateDownloadStatus) Valid() bool {
	switch value {
	case UpdateDownloadStatusDownloading, UpdateDownloadStatusReady, UpdateDownloadStatusInstalling, UpdateDownloadStatusDownloadFailed:
		return true
	default:
		return false
	}
}
func (value *UpdateDownloadStatus) UnmarshalJSON(data []byte) error {
	var wire string
	if err := json.Unmarshal(data, &wire); err != nil || !UpdateDownloadStatus(wire).Valid() {
		return errors.New("invalid UpdateDownloadStatus")
	}
	*value = UpdateDownloadStatus(wire)
	return nil
}
func (value UpdateDownloadStatus) MarshalJSON() ([]byte, error) {
	if !value.Valid() {
		return nil, errors.New("invalid UpdateDownloadStatus")
	}
	return json.Marshal(string(value))
}

type VmPowerState string

const (
	VmPowerStateRunning   VmPowerState = "running"
	VmPowerStateSuspended VmPowerState = "suspended"
	VmPowerStateOff       VmPowerState = "off"
)

func (value VmPowerState) Valid() bool {
	switch value {
	case VmPowerStateRunning, VmPowerStateSuspended, VmPowerStateOff:
		return true
	default:
		return false
	}
}
func (value *VmPowerState) UnmarshalJSON(data []byte) error {
	var wire string
	if err := json.Unmarshal(data, &wire); err != nil || !VmPowerState(wire).Valid() {
		return errors.New("invalid VmPowerState")
	}
	*value = VmPowerState(wire)
	return nil
}
func (value VmPowerState) MarshalJSON() ([]byte, error) {
	if !value.Valid() {
		return nil, errors.New("invalid VmPowerState")
	}
	return json.Marshal(string(value))
}

type VmProviderId string

const (
	VmProviderIdHyperV VmProviderId = "hyperv"
	VmProviderIdVMware VmProviderId = "vmware"
	VmProviderIdSsh    VmProviderId = "ssh"
)

func (value VmProviderId) Valid() bool {
	switch value {
	case VmProviderIdHyperV, VmProviderIdVMware, VmProviderIdSsh:
		return true
	default:
		return false
	}
}
func (value *VmProviderId) UnmarshalJSON(data []byte) error {
	var wire string
	if err := json.Unmarshal(data, &wire); err != nil || !VmProviderId(wire).Valid() {
		return errors.New("invalid VmProviderId")
	}
	*value = VmProviderId(wire)
	return nil
}
func (value VmProviderId) MarshalJSON() ([]byte, error) {
	if !value.Valid() {
		return nil, errors.New("invalid VmProviderId")
	}
	return json.Marshal(string(value))
}

type VmReceiptPhase string

const (
	VmReceiptPhaseSuspending VmReceiptPhase = "suspending"
	VmReceiptPhaseSuspended  VmReceiptPhase = "suspended"
	VmReceiptPhaseResuming   VmReceiptPhase = "resuming"
)

func (value VmReceiptPhase) Valid() bool {
	switch value {
	case VmReceiptPhaseSuspending, VmReceiptPhaseSuspended, VmReceiptPhaseResuming:
		return true
	default:
		return false
	}
}
func (value *VmReceiptPhase) UnmarshalJSON(data []byte) error {
	var wire string
	if err := json.Unmarshal(data, &wire); err != nil || !VmReceiptPhase(wire).Valid() {
		return errors.New("invalid VmReceiptPhase")
	}
	*value = VmReceiptPhase(wire)
	return nil
}
func (value VmReceiptPhase) MarshalJSON() ([]byte, error) {
	if !value.Valid() {
		return nil, errors.New("invalid VmReceiptPhase")
	}
	return json.Marshal(string(value))
}

type WorkStatus string

const (
	WorkStatusRunning     WorkStatus = "running"
	WorkStatusContinuing  WorkStatus = "continuing"
	WorkStatusWaitingUser WorkStatus = "waiting_user"
	WorkStatusPausing     WorkStatus = "pausing"
	WorkStatusPaused      WorkStatus = "paused"
	WorkStatusUnknown     WorkStatus = "unknown"
	WorkStatusReview      WorkStatus = "review"
	WorkStatusFailed      WorkStatus = "failed"
	WorkStatusCompleted   WorkStatus = "completed"
	WorkStatusCancelled   WorkStatus = "cancelled"
)

func (value WorkStatus) Valid() bool {
	switch value {
	case WorkStatusRunning, WorkStatusContinuing, WorkStatusWaitingUser, WorkStatusPausing, WorkStatusPaused, WorkStatusUnknown, WorkStatusReview, WorkStatusFailed, WorkStatusCompleted, WorkStatusCancelled:
		return true
	default:
		return false
	}
}
func (value *WorkStatus) UnmarshalJSON(data []byte) error {
	var wire string
	if err := json.Unmarshal(data, &wire); err != nil || !WorkStatus(wire).Valid() {
		return errors.New("invalid WorkStatus")
	}
	*value = WorkStatus(wire)
	return nil
}
func (value WorkStatus) MarshalJSON() ([]byte, error) {
	if !value.Valid() {
		return nil, errors.New("invalid WorkStatus")
	}
	return json.Marshal(string(value))
}

type WorkerRestorePhase string

const (
	WorkerRestorePhasePrepared    WorkerRestorePhase = "prepared"
	WorkerRestorePhaseInstalling  WorkerRestorePhase = "installing"
	WorkerRestorePhaseCommitted   WorkerRestorePhase = "committed"
	WorkerRestorePhaseRollingBack WorkerRestorePhase = "rolling-back"
)

func (value WorkerRestorePhase) Valid() bool {
	switch value {
	case WorkerRestorePhasePrepared, WorkerRestorePhaseInstalling, WorkerRestorePhaseCommitted, WorkerRestorePhaseRollingBack:
		return true
	default:
		return false
	}
}
func (value *WorkerRestorePhase) UnmarshalJSON(data []byte) error {
	var wire string
	if err := json.Unmarshal(data, &wire); err != nil || !WorkerRestorePhase(wire).Valid() {
		return errors.New("invalid WorkerRestorePhase")
	}
	*value = WorkerRestorePhase(wire)
	return nil
}
func (value WorkerRestorePhase) MarshalJSON() ([]byte, error) {
	if !value.Valid() {
		return nil, errors.New("invalid WorkerRestorePhase")
	}
	return json.Marshal(string(value))
}

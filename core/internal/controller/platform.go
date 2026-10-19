package controller

import "runtime"

func runtimePlatform() string { return runtime.GOOS }

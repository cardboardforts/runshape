package runshape

// onFlushSignal: Windows has no SIGUSR1; runshape-go doesn't record running programs there.
func onFlushSignal(flush func()) {}

module example.com/probe

go 1.21

require (
	example.com/dep v0.0.0
	example.com/probe/sub v0.0.0
)

replace example.com/dep => ../dep

replace example.com/probe/sub => ./sub

# MVC family

### `controller`
Receives the request, picks the model and the view. Expected in `controller`, `presentation` or
`inbound-adapter`. Signals: the framework routes requests to it.
Names: `*Controller`, `*APIView`, `*ViewSet`.

### `view`
Renders the response. Expected in `view` or `presentation`.

### `view-model`
State and commands for one view. Expected in `viewmodel`. Names: `*ViewModel`.

### `presenter`
Decides what the view shows. Expected in `presenter`. Names: `*Presenter`.

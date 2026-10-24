# Sourced by build-android.sh / build-apple.sh: gomobile at the version go.mod pins.
mobile=$(go list -m -f '{{.Version}}' golang.org/x/mobile)
go install "golang.org/x/mobile/cmd/gomobile@${mobile}" "golang.org/x/mobile/cmd/gobind@${mobile}"
export PATH="$(go env GOPATH)/bin:$PATH"
gomobile init

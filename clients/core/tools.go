//go:build tools

// Pins gomobile's bind support in go.mod; gomobile bind needs it in the module graph.
package core

import _ "golang.org/x/mobile/bind"

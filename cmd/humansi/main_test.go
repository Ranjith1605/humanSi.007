package main

import (
	"io"
	"testing"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestParseConfig(t *testing.T) {
	cases := []struct {
		name string
		args []string
		env  map[string]string
		want config
		err  bool
	}{
		{name: "defaults", want: config{addr: ":8080", dataDir: "./data"}},
		{name: "env", env: map[string]string{
			"HUMANSI_ADDR": "127.0.0.1:9", "HUMANSI_DATA_DIR": "/data", "HUMANSI_TRUST_PROXY": "true",
			"HUMANSI_OLLAMA_URL": "http://o:11434", "HUMANSI_SECRET": "s3cret",
		}, want: config{addr: "127.0.0.1:9", dataDir: "/data", trustProxy: true, ollamaURL: "http://o:11434", secret: "s3cret"}},
		{name: "flags beat env", args: []string{"-addr", ":1", "-data", "d", "-trust-proxy=false", "-ollama", ""},
			env:  map[string]string{"HUMANSI_ADDR": ":2", "HUMANSI_TRUST_PROXY": "1", "HUMANSI_OLLAMA_URL": "http://x"},
			want: config{addr: ":1", dataDir: "d"}},
		{name: "blank env is unset", env: map[string]string{"HUMANSI_ADDR": "  "}, want: config{addr: ":8080", dataDir: "./data"}},
		{name: "version", args: []string{"-version"}, want: config{addr: ":8080", dataDir: "./data", showVersion: true}},
		{name: "bad bool env", env: map[string]string{"HUMANSI_TRUST_PROXY": "maybe"}, err: true},
		{name: "unknown flag", args: []string{"-nope"}, err: true},
		{name: "stray argument", args: []string{"serve"}, err: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseConfig(tc.args, env(tc.env), io.Discard)
			if tc.err {
				if err == nil {
					t.Fatalf("want an error, got %+v", got)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Fatalf("got %+v, want %+v", got, tc.want)
			}
		})
	}
}

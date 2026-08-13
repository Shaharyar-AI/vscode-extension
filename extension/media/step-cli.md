## The Claude CLI

CR-Track runs `claude` as a short-lived background process to do the reviewing.
It is the one thing that must exist on every machine.

```
npm i -g @anthropic-ai/claude-code
claude
```

The second command signs you in — once, in a browser. Reviews bill to your own
Claude account.

**Already installed?** CR-Track looks on your PATH and in the usual install
locations, so it usually finds it even when your terminal cannot.

# Security Negative Fixtures

Files in this directory are synthetic inputs that intentionally fail their
corresponding policy when evaluated outside the allowlisted fixture path. They
must never contain a real credential, private key, user token, or production
identifier.

`secret.txt` matches a GitHub token detector and is allowlisted only at this
exact path so the normal repository scan remains green. Security rehearsal
copies it to a non-allowlisted temporary directory and requires the scanner to
reject it.

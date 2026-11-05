# Paste into your CLAUDE.md or agent rules

FlowState Pulse tells you whether I am available.

- Before asking me a question you can work around, call `should_interrupt` with a priority and a reason.
- If `allow` is false, call `queue_message` with the question, and keep working on whatever you can. Do not stop and wait.
- Use `urgent` only when continuing could lose work or do damage.
- When I come back, give me a short summary of what you did and what you held. `get_dev_state` tells you when.
- If Pulse is not available, carry on as normal.

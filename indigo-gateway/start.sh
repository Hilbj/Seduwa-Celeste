export GATEWAY_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
export GATEWAY_ALLOWED_ORIGINS="https://seduwa.ch"
echo "$GATEWAY_TOKEN"

INDIGO_PROP_TOOL="$(command -v indigo_prop_tool)" \
INDIGO_DEVICE="Mount Nexstar" \
GATEWAY_PORT=8768 \
python3 ./indigo_gateway.py

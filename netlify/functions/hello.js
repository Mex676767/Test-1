exports.handler = async function (event, context) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ok: true,
      message: "Netlify Function is working! This is where your Lark App Secret will live safely — never in app.js."
    })
  };
};

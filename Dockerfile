FROM node:22-slim
EXPOSE 4000
CMD ["npx", "@agentstep/gateway", "serve"]

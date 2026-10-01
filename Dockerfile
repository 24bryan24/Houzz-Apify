FROM apify/actor-node-playwright-chrome:24-1.52.0

# NOTE: the playwright version in package.json (1.52.0) must match the
# version baked into this image tag. If you bump one, bump the other.

COPY package.json ./

RUN npm --quiet set progress=false \
 && npm install --only=prod --no-optional \
 && echo "Installed NPM packages:" \
 && (npm list || true) \
 && echo "Node.js version:" \
 && node --version \
 && echo "NPM version:" \
 && npm --version

COPY . ./

CMD npm start --silent

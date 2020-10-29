const { createLogger, format, transports } = require('winston');
const { combine, timestamp, splat } = format;

export const logger = createLogger({
  level: 'info',
  format: combine(splat(), timestamp(), format.json()),
  transports: [new transports.Console()],
});

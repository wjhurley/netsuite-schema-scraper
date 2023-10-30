import * as Winston from 'winston';

export const logger = Winston.createLogger({
    defaultMeta: { service: 'netsuite-schema-scraper' },
    // format: Winston.format.json(),
    levels: Winston.config.syslog.levels,
    transports: [
        //
        // - Write all logs with importance level of `error` or less to `error.log`
        // - Write all logs with importance level of `info` or less to `combined.log`
        //
        new Winston.transports.File({ filename: 'error.log', level: 'error' }),
        new Winston.transports.File({ filename: 'combined.log' }),
    ],
});

//
// If we're not in production then log to the `console` with the format:
// `${info.level}: ${info.message} JSON.stringify({ ...rest }) `
//
if (process.env.NODE_ENV !== 'production') {
    logger.add(new Winston.transports.Console({
        format: Winston.format.combine(
            Winston.format.colorize(),
            // Winston.format.json(),
        ),
    }));
}

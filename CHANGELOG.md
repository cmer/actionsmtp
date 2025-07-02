# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.2] - 2025-07-02

### Fixed
- Fixed unhandled promise rejection errors from DNSBL DNS queries
- Improved DNS resolver reliability by creating new instances per query
- Added global error handler to filter expected ENOTFOUND responses from DNSBL checks

## [1.2.1] - 2025-07-02

### Added
- Version number logging on server startup

### Fixed
- Fixed undefined DNSBL_SERVICES reference in startup logging

## [1.2.0] - 2025-07-02

### Added
- Configurable DNS servers for DNSBL queries with fallback support
- DNS server configuration in `spam.dnsbl.dns_servers` (defaults to Google DNS: 8.8.8.8, 8.8.4.4)

### Changed
- DNSBL checks now use configurable DNS servers instead of system default
- DNS servers are used as fallbacks if the first server is unresponsive
- Improved DNSBL reliability to handle DNS server inconsistencies

### Fixed
- Resolved false positive DNSBL detections caused by DNS server cache inconsistencies
- Enhanced debug logging for DNSBL checks to show DNS server responses

## [1.1.0] - 2025-06-09

### Added
- Configurable server hostname for HELO/EHLO responses

## [1.0.0] -- 2025-06-07

- Initial release

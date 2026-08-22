# Emporia Energy MCP Server

The Emporia Energy MCP Server provides a secure way for LLM applications to access your Emporia Energy device data. This MCP server implementation is in BETA and is subject to change moving forwards. 

This MCP Server supports multiple transport methods: local stdio (requiring local execution similar to a command line program), legacy Server-Sent Events (SSE), and Streamable HTTP. For remote transports, authentication uses the same bearer tokens as the API. OAuth is also supported for remote transports (see **Using the Remote MCP** below).

This MCP server targets the Emporia Energy customer cloud - it does not support Partner related behavior.

Emporia Energy wants to hear any feedback or suggestions you might have related to this tool (or anything else we're working on). Feel free to reach out with any questions/thoughts by emailing [info@emporiaenergy.com](mailto:info@emporiaenergy.com).

To learn more about Emporia Energy and what we're building - feel free to visit our website at [www.emporiaenergy.com](https://www.emporiaenergy.com/). We also have a fairly expansive knowledge base about our products and platform available here: [help.emporiaenergy.com](https://help.emporiaenergy.com/en/).

## Features

- Secure authentication with automatic token refresh
- Device listing with comprehensive device information
- Energy and Power measurement/usage data retrieval with configurable time scales and energy units
- Well-structured API responses with contextual information
- Additional EV Charger-related tools for session/report details

See Feature Status below for additional details on device specific implementation status and what will be coming in the future.

### ⚠️ Important Notes
- For the BETA implementation of this MCP server, you must have a native-Emporia Energy account. It will not work if you've created an Emporia Account using Google or Apple as third-party authentication providers. In the short-term, you can create a new account (with an email/password) and [_share_](https://help.emporiaenergy.com/en/articles/9084330-sharing-devices-across-multiple-emporia-accounts) your Emporia devices to the new account via the Emporia Energy [web](https://web.emporiaenergy.com/) or [mobile app](https://www.emporiaenergy.com/app/). We expect that a future version of this MCP server program will have additional flexibility for these third-party provider accounts.
- Emporia accounts with many devices associated (> 20) may have issues with short context windows and long API responses. Similarly, requesting high amounts of measurement data can produce excessively large API responses that can cause problems for some clients and context-limited LLMs.
- LLM's can be unreliable. While this MCP server program will provide accurate Emporia data from the cloud, the LLM's interpretation (and requesting) of that data may be incorrect at times.

## Examples

TODO

### Tips/Tricks
- Be detailed when requesting specific dates/times of measurement data. Some clients/LLM's may not provide up-to-date timestamps as part of their prompting process, so specifying exact time frames is usually helpful.  
  - Instead of "show me last weeks usage", try "show me usage from May 01, 2025 through May 10, 2025"
- Clarify if you're looking for Power or Energy measurement/usage data as they have separate endpoints/tools (and would be used for separate purposes depending on your goals).  
  - Instead of "show me usage", try "show me energy usage for..." or "show me power measurements for..."

## Release Notes
- May 23, 2025 - Initial release
- August 26, 2025 - Remote MCP released (SSE & Streamable HTTP)

## Prerequisites
- Node.js 18+ (a Docker-based installation option may be available in the future)
- An Emporia Energy account (_native_ account, not Google/Apple created)
- An MCP-capable AI client program (Claude Desktop, Cursor/Windsurf/VS Code, LM Studio/OpenWebUI, etc...)  
  * see [a list of example clients compiled by the official MCP project](https://modelcontextprotocol.io/clients)

## Usage

### Generating the MCP server file locally
You have to create a JavaScript server file locally.  Your MCP client will run this file, you don't need to leave the server running. See Option 3 below for Windows installation.

```bash
# Clone the repository
git clone https://github.com/emporiaenergy/emporia-mcp.git
cd emporia-mcp

# Install dependencies and build project
npm install && npm run build
```

### Configuration in MCP Clients 

To use the local MCP server within an MCP client, add it to your client's MCP configuration file - using NPX is the recommended option (see below for details of running locally).    
Authentication credentials (for your Emporia Energy account) must be provided either through environment variables or a .env file.

#### Option 1: Direct Environment Variables

```json
{
  "mcpServers": {
    "emporia-mcp": {
      "command": "npx",
      "args": ["@emporiaenergy/emporia-mcp"],
      "env": {
        "EMPORIA_ACCOUNT": "<YOUR_EMAIL>",
        "EMPORIA_PASSWORD": "<YOUR_PASSWORD>"
      }
    }
  }
}
```

#### Option 2: Using a .env File

You can provide your credentials in a .env file and specify its path using the `ENV_FILE` environment variable:

```json
{
  "mcpServers": {
    "emporia-mcp": {
      "command": "npx",
      "args": ["@emporiaenergy/emporia-mcp"],
      "env": {
        "ENV_FILE": "/path/to/your/.env"
      }
    }
  }
}
```

Example `.env` file contents:

```env
EMPORIA_ACCOUNT=example@email.com
EMPORIA_PASSWORD=examplepassword1234
```

#### Option 3: Using Node on Windows
There is an [NPX bug on Windows](https://www.reddit.com/r/ClaudeAI/comments/1h3ke5r/help_needed_mcp_not_working_with_claude_on/), so use Node instead.  

```json
{
  "mcpServers": {
    "emporia-mcp": {
      "command": "node",
      "args": ["C:\\dev\\emporia-mcp-server\\build\\index.js"],
      "env": {
        "EMPORIA_ACCOUNT": "<YOUR_EMAIL>",
        "EMPORIA_PASSWORD": "<YOUR_PASSWORD>",
        "DEBUG": "*"
      }
    }
  }
}
```

#
## Cloudflare Workers (cloud)

A Cloudflare Workers deployment lives in [`cloudflare/`](./cloudflare/). It serves Streamable HTTP MCP at `/mcp` with the same Emporia tools and a Cognito OAuth proxy.

```bash
cd cloudflare
npm install
npm start          # wrangler dev
npm run deploy     # wrangler deploy
```

Merges to `main` that touch `cloudflare/**` auto-deploy via [`.github/workflows/deploy-cloudflare.yml`](./.github/workflows/deploy-cloudflare.yml). Configure repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and optional variable `EMPORIA_MCP_ORIGIN`. See [`cloudflare/README.md`](./cloudflare/README.md) for details.

## Using the Remote MCP

To use the remote MCP server, you must use an MCP client which supports remote MCP over SSE or Streamable HTTP transports, such as Claude via the Anthropic API or Claude Desktop (premium plans only).
The Emporia Remote MCP server can be reached at https://mcp.emporiaenergy.com/streamable (Streamable HTTP) or https://mcp.emporiaenergy.com/sse (Legacy SSE). Depending on the client used, you can use 
OAuth to authenticate your MCP requests. Note that some clients may only support the Streamable transport for OAuth authentication. For API clients such as Claude via the Anthropic API, you must pass 
an authentication token retrieved from the OAuth flow in your requests.

# Feature Status

| Category | Feature                             | Status |
|:---------|:------------------------------------|:------:|
| **Authentication** | Account/Password (as env vars)      | ✅ Available |
|  | Account/Password (as .ENV File)     | ✅ Available (Local only) |
|  | OAuth                               | ✅ Available (Remote only) |
|  | Third-party Auth Providers          | 🔄 TBD |
| **Account Information** | List Devices                        | ✅ Available |
|  | Rate Plan Information               | 🔄 TBD |
|  | Recommendations                     | 🔄 TBD |
| **Device Details** | Energy Monitors (w/ channels)       | ✅ Available |
|  | EV Chargers                         | ✅ Available |
|  | Smart Plugs                         | ✅ Available |
|  | Home Batteries                      | ✅ Available |
|  | Appliances                          | ❌ Not Available |
|  | Thermostats                         | ❌ Not Available |
| **Measurements** | Energy Monitors                     | ✅ Available |
|  | EV Chargers                         | ✅ Available |
|  | Smart Plugs                         | ✅ Available |
|  | Home Batteries (inc. SoC)           | ✅ Available |
| **Update Settings/Control** | Energy Monitors                     | ❌ Not Available |
|  | EV Chargers                         | 🔄 TBD |
|  | Smart Plugs                         | 🔄 TBD |
|  | Home Batteries                      | 🔄 TBD |
|  | Appliances                          | ❌ Not Available |
|  | Thermostats                         | ❌ Not Available |
| **Additional Features** | EV Charging Report                  | ✅ Available |
|  | EV Charger Sessions                 | ✅ Available |
| **MCP Implementation** | via NPM                             | ✅ Available |
|  | via Docker                          | 🔄 TBD |
|  | Python (UV)                         | ❌ Not Available |
|  | Tool Configuration (enable/disable) | 🔄 TBD |
|  | Remote SSE                          | ✅ Available |
|  | Remote Streamable HTTP              | ✅ Available |

## Available Tools

The server provides the following tools to help AI assistants interact with your Emporia Energy data:

1. **listDevices**  
   *Get an overview of all your connected Emporia Energy devices*  
   This tool provides a comprehensive inventory of your devices including customer information, device details (models, firmware versions), connection status, and location data. Use this to discover what devices are available for monitoring or control.  
   
   *Example response:* Lists all your Vue energy monitors, EV chargers, and other Emporia devices with their current status and configuration details.

2. **getDeviceDetails**  
   *Get real-time status and details for any device type*  
   This tool returns detailed information about any of your Emporia devices (EV chargers, energy monitors, smart plugs, batteries, etc.) by passing one or more device serial numbers. The response includes relevant details for each device type, such as connection status, current state, charging rates, firmware, and more.
   
   *Example response:* For an EV charger, shows whether your vehicle is connected, actively charging, current charging rate (in amps), and maximum available charging rate. For an energy monitor, shows firmware version, channel counts, and device status. For a smart plug, shows on/off state and connection status. For a battery, shows state of charge, capacity, and power flows.

3. **getDevicesChannels**  
   *Get detailed information about device channels and circuit configurations*  
   This tool provides comprehensive information about all channels for your energy monitoring devices, including main and branch circuits. Essential for understanding your electrical system's structure.
   
   *Example response:* Returns device channel configurations, showing main branch circuits, combined circuits, and channel naming/numbering that can be referenced in other API calls.

4. **getDeviceEnergyUsage**  
   *Analyze energy consumption of any device or circuit over time*  
   This tool retrieves historical energy usage data for any of your devices (EV chargers, energy monitors, smart plugs, batteries, etc.) with customizable time periods and resolutions. For devices with multiple circuits/channels (like energy monitors or batteries), you can specify which circuits to query.  
   
   *Example response:* Returns time-series energy data (in kWh) for specified devices and (optionally) circuits, with timestamps and consumption values at your chosen resolution (from minutes to years).

5. **getDevicePowerUsage**  
   *Monitor real-time power draw from any device or circuit*  
   This tool provides power usage data showing how much electricity your devices or specific circuits are drawing at different times. Useful for understanding power consumption patterns across your electrical system.  
   
   *Example response:* Returns time-series power data (in watts) for specified devices and (optionally) circuits, with timestamps and average power values at minute or 15-minute intervals.

6. **getBatteryStateOfCharge**  
   *Track Home Battery charge levels over time*  
   This tool provides historical state of charge (SoC) data for your home battery storage systems with customizable time periods and resolutions. Essential for understanding how your battery's charge level fluctuates throughout the day, week, or month. Important note - for Home Battery systems only, not applicable for EVSE/Electric Vehicle SoC
   
   *Example response:* Returns time-series state of charge data (as percentage values 0-100%) for battery systems, with timestamps and average state of charge values at your chosen resolution (minutes, hours, or days).

7. **getEVChargingReport**  
   *Get comprehensive reports of your EV charging activity*  
   This tool provides detailed reports about your electric vehicle charging patterns, costs, and potential savings over a specified time period. Essential for understanding charging habits and optimizing for cost savings.
   
   *Example response:* Returns a comprehensive report including daily charging totals, individual charging sessions, energy usage (kWh), charging costs, and potential savings based on utility rate plans.

8. **getEVChargerSessions**  
   *Track plug-in and charging events for your EV chargers*  
   This tool provides detailed information about when vehicles were connected to your EV chargers and the charging sessions that occurred during those connection periods. Useful for understanding vehicle connection times and actual charging times.
   
   *Example response:* Returns a list of plug-in/plug-out events for each charger, including timestamps and energy usage data for each charging session within those connection periods.

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { EmporiaApiService } from "../services/api.js";
import type { DeviceInfo } from "../types/api.js";
import { log } from "../utils/log.js";
import { getAccessToken } from "../auth-context.js";

function textResult(parts: string[], isError = false) {
  return {
    content: parts.map((text) => ({ type: "text" as const, text })),
    ...(isError ? { isError: true } : {}),
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return textResult([`Error: ${message}`], true);
}

/**
 * Register all Emporia tools on an MCP server instance.
 * Auth token is resolved from the request-scoped auth context.
 */
export function registerEmporiaTools(server: McpServer, apiService: EmporiaApiService): void {
  server.registerTool(
    "listDevices",
    {
      description:
        "List all Emporia devices for the authenticated customer, including type, connection status, and location summary.",
    },
    async () => {
      try {
        const result = await apiService.listDevices(getAccessToken());

        const deviceTypes = result.devices.reduce((acc: Record<string, number>, device) => {
          const type = device.type || "unknown";
          acc[type] = (acc[type] || 0) + 1;
          return acc;
        }, {});

        const devices: DeviceInfo[] = result.devices.map((d) => ({
          device_gid: d.id,
          manufacturer_device_id: d.manufacturerDeviceId,
          model: d.model,
          firmware_version: d.firmwareVersion,
          connected: d.connected,
          offline_since: d.offlineSince,
          device_type: d.type,
          display_name: d.name,
          utility_rate_selected: d.locationProperties.utilityRateGid !== null,
          usage_cents_per_kwh:
            d.locationProperties.utilityRateGid === null ? d.locationProperties.usageCentPerKwHour : null,
          billing_cycle_start_day: d.locationProperties.billingCycleStartDay,
          location_summary: {
            latitude_longitude: d.locationProperties.latitudeLongitude,
            time_zone: d.locationProperties.timeZone,
            location_information: d.locationProperties.locationInformation,
            zip_code: d.locationProperties.zipCode,
          },
          device_details: {
            ev_charger: d.deviceDetails.evCharger,
            smart_plug: d.deviceDetails.smartPlug,
            battery: d.deviceDetails.battery,
          },
        }));

        return textResult([
          `Customer: ${result.customerInfo.email}${result.customerInfo.name ? ` (${result.customerInfo.name})` : ""}`,
          `Found ${result.deviceCount} devices. Types: ${Object.entries(deviceTypes)
            .map(([type, count]) => `${type}: ${count}`)
            .join(", ")}`,
          "Device Summary:\n" + JSON.stringify(devices, null, 2),
          "Full device data available by calling relevant 'Details' tools.",
        ]);
      } catch (error) {
        log("Error in listDevices tool", { error: String(error) }, "error");
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "getDevicesChannels",
    {
      description:
        "Get channel/circuit layout for energy monitors. Use channel IDs as circuit_ids in energy/power usage tools.",
    },
    async () => {
      try {
        const result = await apiService.getDevicesChannels(getAccessToken());
        const channelSummary = result.deviceSummaries.map((device) => ({
          deviceGid: device.deviceGid,
          manufacturerDeviceId: device.deviceId,
          parentDeviceId: device.parentDeviceId,
          channelCounts: device.channelCounts,
          availableChannels: device.channelInfo,
        }));

        return textResult([
          `Retrieved channel data for ${result.deviceCount} device(s).`,
          "Channel Summary:\n" + JSON.stringify(channelSummary, null, 2),
          'This data shows available circuits/channels. Use channel IDs as circuit_ids in energy monitor API calls. Note: "Mains" is not a valid circuit_id — use Mains_A/B/C.',
        ]);
      } catch (error) {
        log("Error in getDevicesChannels tool", { error: String(error) }, "error");
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "getDeviceDetails",
    {
      description: "Fetch detailed status for one or more devices by manufacturer serial number.",
      inputSchema: {
        manufacturerIds: z
          .array(z.string())
          .describe("Array of device manufacturer IDs (serial numbers) to fetch details for"),
      },
    },
    async ({ manufacturerIds }) => {
      try {
        const result = await apiService.getDeviceDetails(getAccessToken(), manufacturerIds);
        const content = Object.entries(result).map(
          ([type, { data }]) =>
            `Retrieved ${type} details for ${data.success?.length || 0} device(s). ` +
            (data.error?.length ? `Failed for ${data.error.length} device(s).` : ""),
        );
        return textResult([...content, JSON.stringify(result, null, 2)]);
      } catch (error) {
        log("Error in getDeviceDetails tool", { error: String(error) }, "error");
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "getBatteryStateOfCharge",
    {
      description:
        "Get home battery state-of-charge history. For Home Battery systems only (not EV batteries).",
      inputSchema: {
        device_ids: z
          .array(z.string())
          .describe("Array of home battery manufacturer IDs (serial numbers)"),
        start: z.string().describe("Start timestamp ISO 8601 UTC, e.g. 2025-05-14T00:00:00Z"),
        end: z.string().describe("End timestamp ISO 8601 UTC, e.g. 2025-05-14T23:59:59Z"),
        state_of_charge_resolution: z
          .enum(["MINUTES", "HOURS", "DAYS"])
          .describe("Time resolution for state of charge data"),
      },
    },
    async (params) => {
      try {
        const result = await apiService.getBatteryStateOfCharge(getAccessToken(), params);
        return textResult([
          `Retrieved state of charge data for ${result.stateOfChargeData.success?.length || 0} Battery device(s)` +
            ` from ${result.start} to ${result.end} with ${result.state_of_charge_resolution} resolution.`,
          "Note: Battery state of charge shows percentage over time for charging/discharging analysis.",
          JSON.stringify(result, null, 2),
        ]);
      } catch (error) {
        log("Error in getBatteryStateOfCharge tool", { error: String(error) }, "error");
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "getEVChargingReport",
    {
      description: "Get an EV charging report (energy, cost, savings) for a single EV charger.",
      inputSchema: {
        device_id: z.string().describe("EV charger manufacturer ID (serial number)"),
        start: z.string().describe("Start timestamp ISO 8601 UTC"),
        end: z.string().describe("End timestamp ISO 8601 UTC"),
      },
    },
    async (params) => {
      try {
        const result = await apiService.getEVChargingReport(getAccessToken(), params);
        return textResult([
          `Retrieved EV charging report for device ${result.device_id}` +
            ` from ${result.interval.start} to ${result.interval.end}.`,
          "Note: Includes charging sessions, energy usage, costs, and potential savings.",
          JSON.stringify(result, null, 2),
        ]);
      } catch (error) {
        log("Error in getEVChargingReport tool", { error: String(error) }, "error");
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "getEVChargerSessions",
    {
      description: "Get plug-in and charging sessions for EV chargers.",
      inputSchema: {
        device_ids: z.array(z.string()).describe("Array of EV charger manufacturer IDs"),
        start: z.string().describe("Start timestamp ISO 8601 UTC"),
        end: z.string().describe("End timestamp ISO 8601 UTC"),
      },
    },
    async (params) => {
      try {
        const result = await apiService.getEVChargerSessions(getAccessToken(), params);
        return textResult([
          `Retrieved EV charger sessions for ${result.device_ids.length} device(s)` +
            ` from ${result.start} to ${result.end}.`,
          "Note: Includes plug-in/out events and charging sessions while connected.",
          JSON.stringify(result, null, 2),
        ]);
      } catch (error) {
        log("Error in getEVChargerSessions tool", { error: String(error) }, "error");
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "getDevicePowerUsage",
    {
      description:
        "Get power usage (watts) for devices. For Vue energy monitors, circuit_ids is required (not device_gid).",
      inputSchema: {
        device_ids: z
          .array(z.string())
          .describe("Array of manufacturer IDs (serial numbers) — NOT device_gid"),
        start: z.string().describe("Start timestamp ISO 8601 UTC"),
        end: z.string().describe("End timestamp ISO 8601 UTC"),
        power_resolution: z
          .enum(["MINUTES", "FIFTEEN_MINUTES"])
          .describe("Time resolution for power data"),
        circuit_ids: z
          .array(z.string())
          .describe(
            'Circuit IDs for Vue energy monitors. "Mains" is invalid — use Mains_A, Mains_B, Mains_C. Optional for non-Vue devices.',
          )
          .optional(),
      },
    },
    async (params) => {
      try {
        const result = await apiService.getDevicePowerUsage(getAccessToken(), {
          ...params,
          circuit_ids: params.circuit_ids ?? [],
        });
        const content = Object.entries(result).map(
          ([type, { device_ids, powerData }]) =>
            `Retrieved power usage data for ${type} device(s): ${device_ids.join(", ")}. ` +
            (powerData.success ? `Success count: ${powerData.success.length}` : "") +
            (powerData.error?.length ? `, Failed: ${powerData.error.length}` : ""),
        );
        return textResult([...content, JSON.stringify(result, null, 2)]);
      } catch (error) {
        log("Error in getDevicePowerUsage tool", { error: String(error) }, "error");
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "getDeviceEnergyUsage",
    {
      description:
        "Get energy usage (kWh) for devices. For Vue energy monitors, circuit_ids is required (not device_gid).",
      inputSchema: {
        device_ids: z
          .array(z.string())
          .describe("Array of manufacturer IDs (serial numbers) — NOT device_gid"),
        start: z.string().describe("Start timestamp ISO 8601 UTC"),
        end: z.string().describe("End timestamp ISO 8601 UTC"),
        energy_resolution: z
          .enum(["MINUTES", "FIFTEEN_MINUTES", "HOURS", "DAYS", "WEEKS", "MONTHS", "YEARS"])
          .describe("Time resolution for energy data"),
        circuit_ids: z
          .array(z.string())
          .describe(
            'Circuit IDs for Vue energy monitors. "Mains" is invalid — use Mains_A, Mains_B, Mains_C. Optional for non-Vue devices.',
          )
          .optional(),
      },
    },
    async (params) => {
      try {
        const result = await apiService.getDeviceEnergyUsage(getAccessToken(), {
          ...params,
          circuit_ids: params.circuit_ids ?? [],
        });
        const content = Object.entries(result).map(
          ([type, { device_ids, energyData }]) =>
            `Retrieved energy usage data for ${type} device(s): ${device_ids.join(", ")}. ` +
            (energyData.success ? `Success count: ${energyData.success.length}` : "") +
            (energyData.error?.length ? `, Failed: ${energyData.error.length}` : ""),
        );
        return textResult([...content, JSON.stringify(result, null, 2)]);
      } catch (error) {
        log("Error in getDeviceEnergyUsage tool", { error: String(error) }, "error");
        return errorResult(error);
      }
    },
  );
}

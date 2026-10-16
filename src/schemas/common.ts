import * as z from "zod";

const DOMAIN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function parseHttpUrl(value: string): URL | undefined {
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  return url.protocol === "https:" || url.protocol === "http:"
    ? url
    : undefined;
}

/** A Search Console property: URL-prefix (`https://example.com/`) or Domain (`sc-domain:example.com`). */
export const siteUrlSchema = z
  .string()
  .trim()
  .refine(
    (value) => {
      if (value.startsWith("sc-domain:"))
        return DOMAIN.test(value.slice("sc-domain:".length));
      return parseHttpUrl(value) !== undefined && value.endsWith("/");
    },
    {
      message:
        "siteUrl must be a Search Console property exactly as listed by list_sites: " +
        "a URL-prefix property such as https://www.example.com/ (with trailing slash) " +
        "or a Domain property such as sc-domain:example.com.",
    },
  )
  .describe(
    "Search Console property, exactly as returned by list_sites, e.g. https://www.example.com/ or sc-domain:example.com",
  );

export const httpUrlSchema = z
  .string()
  .trim()
  .refine((value) => parseHttpUrl(value) !== undefined, {
    message: "Must be an absolute http:// or https:// URL.",
  });

function isRealDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, {
    message: "Dates must use the YYYY-MM-DD format.",
  })
  .refine(isRealDate, { message: "Not a valid calendar date." });

/** Whether `inspectionUrl` belongs to the Search Console property `siteUrl`. */
export function isUrlInProperty(
  inspectionUrl: string,
  siteUrl: string,
): boolean {
  if (siteUrl.startsWith("sc-domain:")) {
    const domain = siteUrl.slice("sc-domain:".length).toLowerCase();
    const host = parseHttpUrl(inspectionUrl)?.hostname.toLowerCase();
    return (
      host !== undefined && (host === domain || host.endsWith(`.${domain}`))
    );
  }
  return inspectionUrl.startsWith(siteUrl);
}

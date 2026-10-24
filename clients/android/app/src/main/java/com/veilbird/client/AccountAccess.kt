package com.veilbird.client

import org.json.JSONObject
import java.time.Instant

/** The account's access as the server reports it: period end, traffic quota (all nodes together) and whether either is running out. */
data class AccountAccess(val state: String, val until: Instant?, val quotaBytes: Long?, val remainingBytes: Long) {
    val metered get() = quotaBytes != null
    val low get() = state == "active" && quotaBytes != null && remainingBytes <= quotaBytes / 10
    val ending get() = state == "active" && until != null && until.toEpochMilli() - System.currentTimeMillis() <= 7 * 86_400_000L

    companion object {
        fun from(account: JSONObject): AccountAccess {
            val access = account.optJSONObject("access") ?: return AccountAccess("active", null, null, 0)
            fun long(key: String) = if (access.isNull(key)) null else access.optString(key).toDoubleOrNull()?.toLong()
            val until = if (access.isNull("until")) null else runCatching { Instant.parse(access.getString("until")) }.getOrNull()
            return AccountAccess(access.optString("state", "active"), until, long("quotaBytes"), long("remainingBytes") ?: 0)
        }
    }
}

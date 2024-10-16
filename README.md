# Homeassistant utilities plugin

This plugin was createdy for the necessity to hook some homeassistant mechanisms with Scrypted. The use case is the component Alarm (https://github.com/nielsfaber/alarmo) running on homeassistant to handle an alarm system. It would push over MQTT the currently active devices to monitor my home (cameras, proximity sensors, door/window sensors, lock sensors...) and take action when any of them would be triggered. The only complicated part of this was to send screenshots to my devices when this would happen. Scrypted helps exactly on this part.
<br/>
<br/>
<mark>Some parts of this plugin are highly inspired by the Smart motion sensor</mark>

This plugin offers the following parts:
- A mixin to configure the scrypted devices to work with the plugin
- Customizable notifications
- MQTT autodiscovered devices

# Plugin configuration
 After install the plugin a few configurations should be done on the plugin interface
 ## General
 - Scrypted token: can be found on homeassistant in the sensor created by the scrypted integration
 - NVR url: URL externally accessible to the NVR interface, default ot `https://nvr.scrypted.app`
 - HA credentials, check the `Use HA plugin credentials` to pick the one used on the main Homeassistant plugin
 - Entity regex patterns: regexs to be passed to the HA endpoint to fetch the available entities. The plugin will autogenerate MQTT entities in form of `binary_sensor.{cameraName}_triggered`, an entry for this could be `binary_sensor.(.*)_triggered`. Add any HA entity id you need to map with the scrypted devices

 ##  MQTT
 - Connection parameters
 - `Active entities topic`, MQTT topic to subscribe to activate/deactivate device notifications. The value is expected to be an array of strings and it can contain either the names of the camera or the entity ids or a mix of them. As long as each camera is correctly mapped, the plugin will automatically derive the devices to enable
 - `Active devices`, devices enabled on the MQTT interface, the plugin will publish the current status of the devices listed

 ## Fetched entities
 - `Entities`, contains all the entity ids discoveredy HA
 - `Rooms`, contains all the rooms discovered from HA

 ## Notifier
 - `Minimum notification delay`, delay between notifications from the same camera, can be overridden on the device
 - `Active devices`, devices enabled for the notifications, they can be manually selected or triggered by the MQTT `Active entities topic` topic
 - `Notifiers`, notifiers to be used to send notifications

 ## Texts
 Contains a configurable text contains parameters to show the notification texts. Usefull for translations in local languages. The following parameters can be used:
 - `${room}` - Room name of the device
 - `${time}` - Time string (as defined in the `Detection time` text, default to new Date(${time}).toLocaleString() - i.e. '14/10/2024, 20:41:16'). Read https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/toLocaleString for more info
 - `${nvrLink}` - Public link to the nvr timeline of the camera
 - `${person}` - Person name detected in a familiar detection

 These texts can be overridden for each notifier, an use case would be a whatsapp notifier, where there is no click action and an explicit link to the nvr can be shown

 ## Detection
 - `Motion active duration`, minimum amount of seconds to wait before turning off the triggered sensors
 - `Require Scrypted Detections`, ignore detections coming from the camera
 - `Default score threshold`, default minimum score to pick detections, can be overridden per camera-detection class combination

# Mixin configuration
Group `Homeassistant utilities`

## Metadata
- `Room`, Room the device belongs to. Can be used in the notifications. The selector shows the IDs of the areas coming from HA, notifications will use the friendly name instead
- `EntityID`, Entity ID of the HA entity to map. The default will be the autogenerated MQTT sensor name: `binary_sensor.{cameraName}_triggered`
- `Device class`, deviceClass to be used on the HA entity, any of https://www.home-assistant.io/integrations/binary_sensor/#device-class. Default to `Motion`

## Detection (Available only for Camera/Doorbell devices)
- `Whitelisted zones`, zones that should trigger a notification/motion
- `Blacklisted zones`, zones that should NOT trigger a notification/motion
- `Always enabled zones`, zones that should ALWAYS trigger a notification/motion, regardless of the activation of the camera
- `Detection classes`, detection classes that should trigger a notification/motion
- `Motion active duration`, override of the same plugin config
- `Default score threshold`, override of the same plugin config
- `Score threshold for {eachDetectionClass}`, a specific threshold for each detection class enabled on the camera 

## Notifier
- `HA actions`, actions to be included in the notification in form of JSON string, i.e. `{"action":"open_door","title":"Open door","icon":"sfsymbols:door"}`
- `Minimum notification delay`, override of the same plugin config
- `Skip doorbell notifications`, sensors used as `Custom doorbell button` on the camera will not trigger a notification (available only for Doorbell devices)

## Todo
- Add boundary box to the images
- Add support to nearby locks
- Send clips (if supported by scrypted, not sure yet)

#### Feel free to reach me out on discord (@apocaliss92) for suggestion or feature requests. This plugin contains the features required in my personal case, but there could be more!
"use strict"

const fse = require("fs-extra")
const moment = require("moment-timezone")
const path = require("path")
const _ = require("lodash")
const documentMaker = require("document-generator")
const util = require("util")
const cp = require("child_process")
const faktooraUtilities = require("faktoora-utilities")
const pdftk = require("node-pdftk")
const common = require("../../utils/common")
const slugify = require("../../utils/slugify")
const { stringWriter } = require("xmlbuilder")
const { stringify } = require("querystring")

const defaultUploadFolder = process.env.UPLOAD_DIR || "data"
const postFerdPath = require.resolve("./zugferd/postFerd.ps")
const ZUGFeRDInvoicePath = path.join(defaultUploadFolder, "ZUGFeRD-invoice.xml")
const exec = util.promisify(cp.exec)

async function generateDocumentPDF(payload, { fixingReferenceType }) {
  if (_.get(payload, ["letter"])) {
    let prefix = "Rechnung-Inkl-Begleitschreiben"
    if (fixingReferenceType === "correction") {
      prefix = "Korrekturrechnung-Inkl-Begleitschreiben"
    } else if (fixingReferenceType === "cancellation") {
      prefix = "Stornierung-Inkl-Begleitschreiben"
    }

    const { filename, fullPath, folderPath } = await common.getFilePath({
      prefix,
      id: payload.faktooraId,
      defaultUploadFolder
    })
    fse.writeFileSync(fullPath, await documentMaker.invoice(payload, defaultUploadFolder, { includedLetter: true }))
    return { filename, invoice: payload.id, path: folderPath }
  }
}
const getPrefixFromSubPrefix = subPrefix => {
  let prefix = `Rechnung_${subPrefix}`
  if (fixingReferenceType === "correction") {
    prefix = `Korrekturrechnung_${subPrefix}`
  } else if (fixingReferenceType === "cancellation") {
    prefix = `Stornorechnung_${subPrefix}`
  }
  return prefix
}

const getFormatUsedProfile = usedProfile => {
  switch (usedProfile) {
    case "zf:2:xrechnung":
      return "xrechnung"
    case "zf:2:extended":
      return "ZF:2"
    case "zf:1:extended":
      return "ZF:1"
    default:
      return "simple"
  }
}

const checkDocx = async (variant, templateFilePath) => {
  if (variant === "docx") {
    try {
      await documentMaker.docxtemplater({}, { path: templateFilePath })
      return true
    } catch (docxErr) {
      return false
    }
  }
}

const getValueInvoicePositions = invoicePositions => {
  return _.isArray(invoicePositions) ? invoicePositions : []
}
const getUpload = ($recreate, prefix, id, createdAt) => {
  if ($recreate) {
    return { filename: `${prefix}_${id}.pdf`, path: createdAt.format("YYYY/MM") }
  } else return null
}

const getReceiver = payload => _.get(payload, "$receiver") || _.get(payload, ["owner", "id"])

const checkHasTemplateFile = templateFilePath => templateFilePath && fse.lstatSync(templateFilePath).isFile() && fse.existsSync(templateFilePath)

const getTemplateFilePath = (invoiceTemplateFile) => {
  return _.isString(invoiceTemplateFile) ? path.join(defaultUploadFolder, "filestorage", invoiceTemplateFile) : null
}

const createPDF = async (
  canCreatePDF,
  payload,
  fixing,
  filename,
  folderPath,
  pdfPath,
  hasTemplateFile
) => {
  let documentFile, invoiceFile
  if (canCreatePDF) {
    documentFile = await generateDocumentPDF(payload, { ...fixing })
    invoiceFile = { filename, path: folderPath, fullPath: pdfPath }

    fse.writeFileSync(
      hasTemplateFile ? `${pdfPath}.pdf` : pdfPath,
      await documentMaker.invoice(payload, defaultUploadFolder)
    )
    if (hasTemplateFile) {
      await pdftk
        .input([`${pdfPath}.pdf`])
        .cat()
        .output(pdfPath)
      fse.unlinkSync(`${pdfPath}.pdf`)
    }
  }
  return {
    documentFile,
    invoiceFile
  }
}

const generateZF1ExtendedPDF = (canCreatePDF, payload, pdfPath) =>{
  if (canCreatePDF) {
    // generate some needed data for XML create process (collect product taxes, discount etc.)
    const calculateAmount = faktooraUtilities.calculateAmount(
      _.get(payload, ["data", "invoicePositions"]),
      _.get(payload, ["data", "totaldiscount", "value"]),
      _.get(payload, ["data", "deduction"]),
      _.get(payload, ["data", "subTotalsDefinitions"])
    )

    // generate the XML data then write to file
    const zugxml = await faktooraUtilities.generateZF1XmlInvoice(payload, calculateAmount)

    fse.writeFileSync(ZUGFeRDInvoicePath, zugxml)

    // generate PDF/A3 with included XML data
    const outputFile = `${pdfPath}.tmp`
    await exec(
      `gs -dPDFA=3 -dBATCH -dNOPAUSE -dNOSAFER -sColorConversionStrategy=sRGB -sDEVICE=pdfwrite -sOutputFile=${outputFile} ${postFerdPath} ${pdfPath} -c "[ /Title (${path.basename(
        filename,
        ".pdf"
      )}) /DOCINFO pdfmark" -f`
    )
    await exec(`mv ${outputFile} ${pdfPath}`)

    // clear previous invoice XML data just in case
    fse.writeFileSync(ZUGFeRDInvoicePath, "")
  }
}


module.exports.makeInvoiceFile = async function makeInvoiceFile(payload) {
  const subPrefix = slugify(_.get(payload, "invoiceNumber", ""), "_")
  const $recreate = _.get(payload, "$recreate", false)
  const $receiver = getReceiver(payload)
  const fixingReferenceId = _.get(payload, "fixingReferenceId")
  const fixingReferenceType = _.get(payload, "fixingReferenceType")

  let prefix = getPrefixFromSubPrefix(subPrefix)
  const id = _.get(payload, "faktooraId", "")

  let createdAt = _.get(payload, "created_at")
  createdAt = createdAt && moment(createdAt).isValid() ? moment(createdAt) : moment()

  let upload = getUpload($recreate, prefix, id, createdAt)

  const { fullPath: pdfPath, folderPath, filename } = await common.getFilePath(
    {
      upload,
      prefix,
      id,
      defaultUploadFolder,
      ignorePathDate: !$recreate
    },
    "pdf"
  )

  let canCreatePDF = true
  let documentFile, invoiceFile, ZUGFeRDPayload

  const uploadedInvoiceFile = _.get(payload, ["data", "uploadedInvoiceFile"])
  if (uploadedInvoiceFile && fse.existsSync(uploadedInvoiceFile)) {
    fse.renameSync(uploadedInvoiceFile, pdfPath)
  } else {
    // Determine invoice template
    const invoiceTemplateFile = _.trim(_.get(payload, ["data", "template", "label"]))
    const templateFilePath = getTemplateFilePath(invoiceTemplateFile)
    const hasTemplateFile = checkHasTemplateFile(templateFilePath)

    _.set(payload, "data.template.variant", hasTemplateFile ? "docx" : "legacy")
    _.set(payload, "data.template.path", hasTemplateFile ? templateFilePath : null)
    _.set(payload, "data.template.output", pdfPath)

    canCreatePDF = checkDocx(payload.data.template.variant, templateFilePath)

    let createPDFresult = await createPDF(
      canCreatePDF,
      payload,
      {
      fixingReferenceId,
      fixingReferenceType},
      filename,
      folderPath,
      pdfPath,
      hasTemplateFile
    )
    documentFile = createPDFresult.documentFile
    invoiceFile = createPDFresult.invoiceFile
  }

  const usedProfile = _.get(payload, "usedProfile", "simple")
  try {
    switch (usedProfile) {
      case "zf:2:extended":
      case "zf:2:xrechnung":
        const values = _.omit(payload, ["data", "debtor", "owner"])
        values.pdfPath = pdfPath
        values.$receiver = $receiver
        const seller = _.assign({}, payload.owner)
        values.seller = seller
        const buyer = _.assign({}, payload.debtor)
        values.buyer = buyer
        values.invoiceType = _.toString(payload.data.invoiceType)
        values.invoiceTypeCode = _.get(payload, ["data", "invoiceTypeCode"], "380")
        values.serviceDateRangeStart = _.toString(payload.data.serviceDateRangeStart)
        values.serviceDateRangeEnd = _.toString(payload.data.serviceDateRangeEnd)
        values.serviceDate = _.toString(payload.data.serviceDate)
        values.deliveryDate = _.toString(payload.data.deliveryDate)
        values.totaldiscount = payload.data.totaldiscount
        values.deduction = payload.data.deduction
        values.taxExemptionReasonMessage = _.get(payload, ["data", "taxExemptionReasonMessage"])
        values.shippingOrderNumber = _.toString(payload.data.shippingOrderNumber)
        values.orderNumber = _.toString(payload.data.orderNumber)
        values.supplierNumber = _.toString(payload.data.supplierNumber)
        values.introduction = _.toString(payload.data.introduction)
        values.paymentterm = _.toString(payload.data.paymentterm)
        values.postscript = _.toString(payload.data.postscript)
        const invoicePositions = _.get(payload, ["data", "invoicePositions"])
        // values.invoicePositions = _.isArray(invoicePositions) ? invoicePositions : []
        values.invoicePositions = getValueInvoicePositions(invoicePositions)
        values.specifiedTradeSettlementPaymentMeans = _.get(payload, ["data", "specifiedTradeSettlementPaymentMeans"])
        values.specifiedTradePaymentTerms = _.get(payload, ["data", "specifiedTradePaymentTerms"])
        values.transport = _.get(payload, ["data", "transport"])
        values.allowance = _.get(payload, ["data", "allowance"])
        values.deliveryNote = _.get(payload, ["data", "deliveryNote"])
        values.deliveryId = _.get(payload, ["data", "debtor", "extras", "deliveryId"])
        values.deliveryGlobalId = _.get(payload, ["data", "debtor", "extras", "deliveryGlobalId"])
        values.deliverySchemeId = _.get(payload, ["data", "debtor", "extras", "deliverySchemeId"])
        values.sellerId = _.get(payload, ["data", "sellerId"])
        values.sellerGlobalId = _.get(payload, ["data", "sellerGlobalId"])
        values.sellerSchemeId = _.get(payload, ["data", "sellerSchemeId"])
        values.sellerName = _.get(payload, ["data", "sellerName"])
        values.sellerPhone = _.get(payload, ["data", "telephone"])
        values.sellerEmail = _.get(payload, ["data", "email"])
        values.sellerPostcode = _.get(payload, ["data", "sellerPostcode"])
        values.sellerStreet = _.get(payload, ["data", "sellerStreet"])
        values.sellerCity = _.get(payload, ["data", "sellerCity"])
        values.sellerSpecifiedLegalOrganization = _.get(payload, ["data", "sellerSpecifiedLegalOrganization"])
        values.sellerCountry = _.get(payload, ["data", "sellerCountry"])
        values.sellerVatId = _.get(payload, ["data", "valueAddedTaxId"])
        values.sellerTaxId = _.get(payload, ["data", "taxIdentNumber"])
        values.sellerIban = _.get(payload, ["data", "sellerIban"])
        values.sellerBankCardHolder = _.get(payload, ["data", "sellerBankCardHolder"])
        values.additionalReferences = _.get(payload, ["data", "additionalReferences"])
        values.currency = _.get(payload, ["data", "currency"], "EUR")
        values.contactPerson = _.assign({}, _.get(payload, ["data", "contactPerson"]))
        values.format = getFormatUsedProfile(usedProfile)
        values.buyerReference = _.get(payload, ["data", "buyerReference"])
        values.contractReferencedDocument = _.get(payload, ["data", "contractReferencedDocument"])
        values.invoiceReferencedDocument = _.get(payload, ["data", "invoiceReferencedDocument"])
        values.invoiceTypeCode = _.get(payload, ["data", "invoiceTypeCode"])
        values.notes = _.get(payload, ["data", "notes"])
        values.definedTradeContact = _.assign({}, _.get(payload, ["data", "customerContactPerson"]))

        ZUGFeRDPayload = await faktooraUtilities.generateZF2XmlInvoice(values)
        break
      case "zf:1:extended":
        generateZF1ExtendedPDF(canCreatePDF, payload, pdfPath)
        break
    }
  } catch (err) {
    console.log(err)
  }

  return {
    $receiver,
    ZUGFeRDPayload,
    documentFile,
    invoiceFile,
    enabledWebhook: !!payload.enabledWebhook,
    invoiceId: payload.id
  }
}